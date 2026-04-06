'use strict';

/**
 * alpacaExecution.js
 * Handles all Alpaca order placement and position management.
 * Switches paper/live via ALPACA_MODE env var.
 *
 * Exit structure (25/25/50):
 *   Leg 1 — sell 25% at 1R → cancel original stop → place breakeven stop on 75%
 *   Leg 2 — sell 25% at 2R → move stop to 1R on remaining 50%
 *   Leg 3 — 50% runner hard-exits at 10:30am ET (flatten)
 *
 * All R levels recalc from actual Alpaca fill price, not planned entry.
 *
 * Extended hours handling:
 *   Pre/after market — limit orders only, extended_hours: true
 *   Regular hours    — market orders, extended_hours: false
 */

const axios = require('axios');

// ─── BASE URL ────────────────────────────────────────────────────────────────

function getBaseUrl() {
  return process.env.ALPACA_MODE === 'live'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';
}

function getHeaders() {
  return {
    'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    'Content-Type':        'application/json',
  };
}

async function alpacaGet(path) {
  const res = await axios.get(`${getBaseUrl()}${path}`, {
    headers: getHeaders(),
    timeout: 8000,
  });
  return res.data;
}

async function alpacaPost(path, body) {
  const res = await axios.post(`${getBaseUrl()}${path}`, body, {
    headers: getHeaders(),
    timeout: 8000,
  });
  return res.data;
}

async function alpacaDelete(path) {
  const res = await axios.delete(`${getBaseUrl()}${path}`, {
    headers: getHeaders(),
    timeout: 8000,
  });
  return res.data;
}

// ─── SESSION DETECTION ───────────────────────────────────────────────────────

/**
 * Detect if we are currently in extended hours (pre-market or after-hours).
 * Uses pure UTC math — no locale string parsing, safe on Railway Linux.
 * EDT = UTC-4 (Mar-Nov), EST = UTC-5 (Nov-Mar)
 */
function getEtMinutes() {
  const now      = new Date();
  const jan      = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul      = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDst    = now.getTimezoneOffset() < Math.max(jan, jul);
  const offsetMs = (isDst ? -4 : -5) * 60 * 60 * 1000;
  const etNow    = new Date(now.getTime() + offsetMs);
  return etNow.getUTCHours() * 60 + etNow.getUTCMinutes();
}

function isExtendedHours() {
  const mins = getEtMinutes();
  // Regular hours: 9:30am (570) to 4:00pm (960)
  return mins < 570 || mins >= 960;
}

/**
 * Build order body handling extended vs regular hours automatically.
 *
 * Extended hours rules (Alpaca):
 *   - Must be limit orders (market orders rejected)
 *   - Must be DAY time_in_force
 *   - extended_hours: true required
 *
 * Regular hours:
 *   - Market orders fine
 *   - extended_hours: false
 */
function buildOrderBody({ symbol, qty, side, type, limitPrice, stopPrice }) {
  const extended = isExtendedHours();

  const base = {
    symbol,
    qty,
    side,
    time_in_force:  'day',
    extended_hours: extended,
  };

  if (extended) {
    // Extended hours — must be limit order
    if (type === 'market') {
      // Convert market buy to limit at ask + small buffer
      // Use provided limitPrice or fallback — caller must provide for extended
      return {
        ...base,
        type:        'limit',
        limit_price: limitPrice
          ? parseFloat(limitPrice).toFixed(2)
          : null,
      };
    }
    if (type === 'limit') {
      return {
        ...base,
        type:        'limit',
        limit_price: parseFloat(limitPrice).toFixed(2),
      };
    }
    if (type === 'stop') {
      // Stops during extended hours must be stop_limit
      // Use stop as trigger, stop - 1 cent as limit (guaranteed fill on thin stocks)
      const stop  = parseFloat(stopPrice);
      const limit = parseFloat((stop * 0.98).toFixed(2)); // 2% below stop as limit
      return {
        ...base,
        type:        'stop_limit',
        stop_price:  stop.toFixed(2),
        limit_price: limit.toFixed(2),
      };
    }
  } else {
    // Regular hours — market and stop orders work normally
    if (type === 'market') {
      return { ...base, type: 'market' };
    }
    if (type === 'limit') {
      return {
        ...base,
        type:        'limit',
        limit_price: parseFloat(limitPrice).toFixed(2),
      };
    }
    if (type === 'stop') {
      return {
        ...base,
        type:       'stop',
        stop_price: parseFloat(stopPrice).toFixed(2),
      };
    }
  }

  return base;
}

// ─── BUYING POWER ────────────────────────────────────────────────────────────

async function getBuyingPower() {
  const account = await alpacaGet('/v2/account');
  return {
    buyingPower:    parseFloat(account.buying_power),
    cash:           parseFloat(account.cash),
    portfolioValue: parseFloat(account.portfolio_value),
    mode:           process.env.ALPACA_MODE || 'paper',
  };
}

// ─── PLACE ENTRY ORDER ───────────────────────────────────────────────────────

/**
 * Places the entry bracket:
 *   - Market buy (or limit during extended hours) for `shares`
 *   - Stop-loss order at `stopPrice` (full shares)
 *
 * limitPrice is required for pre/after market entries.
 * During regular hours it is ignored and a market order is used.
 *
 * Returns { entryOrder, stopOrder }
 */
async function placeEntry({ ticker, shares, stopPrice, limitPrice }) {
  const extended = isExtendedHours();
  console.log(`[AlpacaExec] placeEntry ${ticker} x${shares} | extended: ${extended} | stop: ${stopPrice} | limit: ${limitPrice}`);

  // Entry order
  const entryBody = buildOrderBody({
    symbol:     ticker,
    qty:        shares,
    side:       'buy',
    type:       'market', // buildOrderBody converts to limit if extended
    limitPrice, // used only if extended
    stopPrice,
  });

  if (extended && !entryBody.limit_price) {
    throw new Error('limitPrice required for extended hours entry — pass entryHigh from confirm sheet');
  }

  const entryOrder = await alpacaPost('/v2/orders', entryBody);

  // Stop loss order
  const stopBody = buildOrderBody({
    symbol:    ticker,
    qty:       shares,
    side:      'sell',
    type:      'stop',
    stopPrice,
    limitPrice: null,
  });

  const stopOrder = await alpacaPost('/v2/orders', stopBody);

  console.log(`[AlpacaExec] Entry order: ${entryOrder.id} | Stop order: ${stopOrder.id}`);
  return { entryOrder, stopOrder };
}

// ─── PARTIAL SELL ─────────────────────────────────────────────────────────────

async function placeLimitSell({ ticker, shares, limitPrice }) {
  const body = buildOrderBody({
    symbol:     ticker,
    qty:        shares,
    side:       'sell',
    type:       'limit',
    limitPrice,
  });
  return alpacaPost('/v2/orders', body);
}

// ─── STOP ORDER ───────────────────────────────────────────────────────────────

async function placeStopSell({ ticker, shares, stopPrice }) {
  const body = buildOrderBody({
    symbol:    ticker,
    qty:       shares,
    side:      'sell',
    type:      'stop',
    stopPrice,
  });
  return alpacaPost('/v2/orders', body);
}

// ─── CANCEL ORDER ─────────────────────────────────────────────────────────────

async function cancelOrder(orderId) {
  try {
    await alpacaDelete(`/v2/orders/${orderId}`);
    return true;
  } catch (e) {
    // 422 = already filled/cancelled — treat as success
    if (e.response?.status === 422) return true;
    console.error('[AlpacaExec] cancelOrder error:', e.message);
    return false;
  }
}

// ─── CANCEL ALL ORDERS FOR TICKER ─────────────────────────────────────────────

async function cancelAllOrdersForTicker(ticker) {
  try {
    const orders   = await alpacaGet('/v2/orders?status=open&limit=50');
    const relevant = orders.filter(o => o.symbol === ticker);
    await Promise.all(relevant.map(o => cancelOrder(o.id)));
    return relevant.length;
  } catch (e) {
    console.error('[AlpacaExec] cancelAllOrders error:', e.message);
    return 0;
  }
}

// ─── FLATTEN POSITION ─────────────────────────────────────────────────────────

/**
 * Cancel all open orders for ticker, then market-sell remaining position.
 * Used for 10:30am ET hard exit and manual flatten.
 * During extended hours uses limit order at current bid.
 */
async function flattenPosition(ticker) {
  // 1. Cancel all open orders
  await cancelAllOrdersForTicker(ticker);

  // 2. Get current position qty
  let qty = 0;
  try {
    const pos = await alpacaGet(`/v2/positions/${ticker}`);
    qty = parseInt(pos.qty);
  } catch (e) {
    if (e.response?.status === 404) return { flattened: true, qty: 0 };
    throw e;
  }

  if (qty <= 0) return { flattened: true, qty: 0 };

  // 3. Sell — market during regular hours, limit during extended
  const extended = isExtendedHours();
  let orderBody;

  if (extended) {
    // Get current price for limit
    let limitPrice;
    try {
      const snap = await axios.get(
        `https://data.alpaca.markets/v2/stocks/${ticker}/quotes/latest`,
        { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY }, timeout: 5000 }
      );
      const bid   = snap.data?.quote?.bp || 0;
      const ask   = snap.data?.quote?.ap || 0;
      limitPrice  = bid > 0 ? bid : (ask > 0 ? ask * 0.99 : null);
    } catch (e) {
      limitPrice = null;
    }

    if (!limitPrice) {
      throw new Error('Cannot flatten during extended hours — unable to get current price');
    }

    orderBody = {
      symbol:         ticker,
      qty,
      side:           'sell',
      type:           'limit',
      limit_price:    parseFloat(limitPrice).toFixed(2),
      time_in_force:  'day',
      extended_hours: true,
    };
  } else {
    orderBody = {
      symbol:         ticker,
      qty,
      side:           'sell',
      type:           'market',
      time_in_force:  'day',
      extended_hours: false,
    };
  }

  const order = await alpacaPost('/v2/orders', orderBody);
  console.log(`[AlpacaExec] Flatten ${ticker} x${qty} | extended: ${extended} | order: ${order.id}`);
  return { flattened: true, qty, orderId: order.id };
}

// ─── GET POSITION ─────────────────────────────────────────────────────────────

async function getPosition(ticker) {
  try {
    const pos = await alpacaGet(`/v2/positions/${ticker}`);
    return {
      ticker:    pos.symbol,
      qty:       parseInt(pos.qty),
      avgEntry:  parseFloat(pos.avg_entry_price),
      marketVal: parseFloat(pos.market_value),
      unrealPnl: parseFloat(pos.unrealized_pl),
      currentPx: parseFloat(pos.current_price),
    };
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

// ─── GET ORDER ────────────────────────────────────────────────────────────────

async function getOrder(orderId) {
  return alpacaGet(`/v2/orders/${orderId}`);
}

// ─── COMPUTE R LEVELS FROM FILL ───────────────────────────────────────────────

/**
 * Called once entry order fill price is confirmed.
 * All exits recalculate from actual fill, not planned entry.
 */
function computeRLevels({ fillPrice, stopPrice, totalShares }) {
  const rDist      = fillPrice - stopPrice;
  const r1Price    = parseFloat((fillPrice + rDist).toFixed(4));
  const r2Price    = parseFloat((fillPrice + rDist * 2).toFixed(4));

  const leg1Shares   = Math.round(totalShares * 0.25);
  const leg2Shares   = Math.round(totalShares * 0.25);
  const runnerShares = totalShares - leg1Shares - leg2Shares;

  return {
    fillPrice,
    stopPrice,
    rDist,
    r1Price,
    r2Price,
    breakevenStop: fillPrice,
    r1Stop:        r1Price,
    leg1Shares,
    leg2Shares,
    runnerShares,
  };
}

module.exports = {
  getBuyingPower,
  placeEntry,
  placeLimitSell,
  placeStopSell,
  cancelOrder,
  cancelAllOrdersForTicker,
  flattenPosition,
  getPosition,
  getOrder,
  computeRLevels,
  isExtendedHours,
  getEtMinutes,
};
