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

// ─── BUYING POWER ────────────────────────────────────────────────────────────

async function getBuyingPower() {
  const account = await alpacaGet('/v2/account');
  return {
    buyingPower:   parseFloat(account.buying_power),
    cash:          parseFloat(account.cash),
    portfolioValue: parseFloat(account.portfolio_value),
    mode:          process.env.ALPACA_MODE || 'paper',
  };
}

// ─── PLACE ENTRY ORDER ───────────────────────────────────────────────────────

/**
 * Places the entry bracket:
 *   - Market buy for `shares`
 *   - Stop-loss order at `stopPrice` (full shares)
 *
 * Returns { entryOrder, stopOrder }
 * R levels will be recalculated once fill price is confirmed by orderMonitor.
 */
async function placeEntry({ ticker, shares, stopPrice }) {
  // Market buy
  const entryOrder = await alpacaPost('/v2/orders', {
    symbol:        ticker,
    qty:           shares,
    side:          'buy',
    type:          'market',
    time_in_force: 'day',
    extended_hours: true,
  });

  // Full-size stop loss immediately
  const stopOrder = await alpacaPost('/v2/orders', {
    symbol:        ticker,
    qty:           shares,
    side:          'sell',
    type:          'stop',
    stop_price:    stopPrice.toFixed(2),
    time_in_force: 'day',
    extended_hours: true,
  });

  return { entryOrder, stopOrder };
}

// ─── PARTIAL SELL ─────────────────────────────────────────────────────────────

async function placeLimitSell({ ticker, shares, limitPrice }) {
  return alpacaPost('/v2/orders', {
    symbol:        ticker,
    qty:           shares,
    side:          'sell',
    type:          'limit',
    limit_price:   limitPrice.toFixed(2),
    time_in_force: 'day',
    extended_hours: true,
  });
}

// ─── STOP ORDER ───────────────────────────────────────────────────────────────

async function placeStopSell({ ticker, shares, stopPrice }) {
  return alpacaPost('/v2/orders', {
    symbol:        ticker,
    qty:           shares,
    side:          'sell',
    type:          'stop',
    stop_price:    stopPrice.toFixed(2),
    time_in_force: 'day',
    extended_hours: true,
  });
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
    const orders = await alpacaGet('/v2/orders?status=open&limit=50');
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
    // No position — already flat
    if (e.response?.status === 404) return { flattened: true, qty: 0 };
    throw e;
  }

  if (qty <= 0) return { flattened: true, qty: 0 };

  // 3. Market sell
  const order = await alpacaPost('/v2/orders', {
    symbol:        ticker,
    qty,
    side:          'sell',
    type:          'market',
    time_in_force: 'day',
    extended_hours: true,
  });

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
  const rDist   = fillPrice - stopPrice;
  const r1Price = parseFloat((fillPrice + rDist).toFixed(4));
  const r2Price = parseFloat((fillPrice + rDist * 2).toFixed(4));

  const leg1Shares = Math.round(totalShares * 0.25);            // 25% at 1R
  const leg2Shares = Math.round(totalShares * 0.25);            // 25% at 2R
  const runnerShares = totalShares - leg1Shares - leg2Shares;   // 50% runner

  return {
    fillPrice,
    stopPrice,
    rDist,
    r1Price,
    r2Price,
    breakevenStop: fillPrice,   // stop moves here after leg 1
    r1Stop:        r1Price,     // stop moves here after leg 2
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
};
