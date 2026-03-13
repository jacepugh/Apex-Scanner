/**
 * /api/pulse — Market Pulse endpoint
 * Returns price + % change for SPY, QQQ, IWM, VIX, XBI, BTC
 * Works pre-market, market hours, after-hours, and closed
 */

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const CACHE_TTL = 30; // seconds

function getPolygonUrl(poly, apiKey) {
  if (poly.startsWith('X:'))
    return `https://api.polygon.io/v2/snapshot/locale/global/markets/crypto/tickers/${poly}?apiKey=${apiKey}`;
  if (poly.startsWith('I:'))
    return `https://api.polygon.io/v2/snapshot/locale/us/markets/indices/tickers/${poly}?apiKey=${apiKey}`;
  return `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${poly}?apiKey=${apiKey}`;
}

function getMarketSession() {
  const now  = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const min  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  const mins = hour * 60 + min;
  if (mins >= 240  && mins < 570)  return 'premarket';
  if (mins >= 570  && mins < 960)  return 'regular';
  if (mins >= 960  && mins < 1200) return 'afterhours';
  return 'closed';
}

function parsePulseResponse(poly, data) {
  const session = getMarketSession();

  // ── Crypto (X:) ──
  if (poly.startsWith('X:')) {
    const t      = data.ticker || {};
    const day    = t.day || {};
    const prev   = t.prevDay || {};
    // Use last trade price for most current crypto value
    const price  = t.lastTrade?.p || day.c || prev.c || 0;
    const prevClose = prev.c || day.o || 0;
    const chgPct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
    return price > 0 ? { price, prevClose, chgPct: parseFloat(chgPct.toFixed(2)) } : null;
  }

  // ── Index (I:) — VIX only available during market hours ──
  if (poly.startsWith('I:')) {
    const t      = data.ticker || {};
    const value  = t.value || t.day?.c || 0;
    const prev   = t.prevDay?.c || 0;
    const chgPct = prev > 0 ? ((value - prev) / prev) * 100 : 0;
    return value > 0 ? { price: value, prevClose: prev, chgPct: parseFloat(chgPct.toFixed(2)) } : null;
  }

  // ── Stocks / ETFs ──
  const t        = data.ticker || {};
  const day      = t.day     || {};
  const prev     = t.prevDay || {};
  const prevClose = prev.c   || 0;

  // Pick the most current price based on session
  let price = 0;
  if (session === 'premarket' || session === 'afterhours') {
    // Extended hours: last trade is most current, fall back to mid-quote, then day close
    const lastTrade = t.lastTrade?.p || 0;
    const askPrice  = t.lastQuote?.P || 0;
    const bidPrice  = t.lastQuote?.p || 0;
    const midQuote  = askPrice > 0 && bidPrice > 0 ? (askPrice + bidPrice) / 2 : 0;
    price = lastTrade || midQuote || askPrice || day.c || prevClose;
  } else if (session === 'regular') {
    price = day.c || t.lastTrade?.p || prevClose;
  } else {
    // Closed — use last available close
    price = day.c || t.lastTrade?.p || prevClose;
  }

  if (!price || price <= 0) return null;

  const chgPct = prevClose > 0
    ? ((price - prevClose) / prevClose) * 100
    : (t.todaysChangePerc || 0);

  return {
    price:     parseFloat(price.toFixed(2)),
    prevClose: parseFloat(prevClose.toFixed(2)),
    chgPct:    parseFloat(chgPct.toFixed(2)),
    session,
  };
}

// In-memory cache
const pulseCache = new Map();

// GET /api/pulse/debug?ticker=SPY — returns raw Polygon response for diagnosis
router.get('/debug', async (req, res) => {
  const poly   = req.query.ticker || 'SPY';
  const apiKey = process.env.POLYGON_API_KEY || '';
  if (!apiKey) return res.status(500).json({ error: 'no api key' });
  try {
    const url      = getPolygonUrl(poly, apiKey);
    const response = await axios.get(url, { timeout: 8000 });
    // Return raw response so we can see exact field structure
    res.json({ poly, url: url.replace(apiKey, 'REDACTED'), raw: response.data });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
});

// GET /api/pulse?ticker=SPY
router.get('/', async (req, res) => {
  const poly   = req.query.ticker;
  const apiKey = process.env.POLYGON_API_KEY || '';

  if (!poly)   return res.status(400).json({ error: 'ticker required' });
  if (!apiKey) return res.status(500).json({ error: 'no api key' });

  const cacheKey = 'pulse_' + poly;
  const cached   = pulseCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL * 1000) {
    return res.json(cached.data);
  }

  try {
    const url      = getPolygonUrl(poly, apiKey);
    const response = await axios.get(url, { timeout: 8000 });
    const parsed   = parsePulseResponse(poly, response.data);

    if (!parsed) return res.status(404).json({ error: 'no data for ' + poly });

    pulseCache.set(cacheKey, { data: parsed, ts: Date.now() });
    res.json(parsed);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('[/api/pulse]', poly, status, err.message);
    // Return stale cache on error rather than failing completely
    const stale = pulseCache.get(cacheKey);
    if (stale) return res.json({ ...stale.data, stale: true });
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
