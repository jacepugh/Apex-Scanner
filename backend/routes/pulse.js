/**
 * /api/pulse — Market Pulse endpoint
 * Returns price + % change for SPY, QQQ, IWM, VIX, XBI, BTC
 * Proxies Polygon so the API key stays server-side
 */

const express = require('express');
const axios   = require('axios');
const router  = express.Router();

const CACHE_TTL = 30; // seconds — pulse data refreshes every 30s

// Polygon endpoint map per ticker type
function getPolygonUrl(poly, apiKey) {
  if (poly.startsWith('X:')) {
    // Crypto — use crypto snapshot
    return `https://api.polygon.io/v2/snapshot/locale/global/markets/crypto/tickers/${poly}?apiKey=${apiKey}`;
  }
  if (poly.startsWith('I:')) {
    // Index — use indices snapshot
    return `https://api.polygon.io/v2/snapshot/locale/us/markets/indices/tickers/${poly}?apiKey=${apiKey}`;
  }
  // Stocks/ETFs
  return `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${poly}?apiKey=${apiKey}`;
}

function parsePulseResponse(poly, data) {
  // Stocks/ETFs
  if (data.ticker) {
    const t        = data.ticker;
    const price    = t.day?.c || t.lastTrade?.p || t.prevDay?.c || 0;
    const prevClose= t.prevDay?.c || 0;
    const chgPct   = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : (t.todaysChangePerc || 0);
    return { price: parseFloat(price.toFixed(2)), prevClose, chgPct: parseFloat(chgPct.toFixed(2)) };
  }
  // Crypto
  if (data.ticker?.day) {
    const price  = data.ticker.day.c || 0;
    const prev   = data.ticker.prevDay?.c || 0;
    const chgPct = prev > 0 ? ((price - prev) / prev) * 100 : 0;
    return { price, prevClose: prev, chgPct: parseFloat(chgPct.toFixed(2)) };
  }
  return null;
}

// Simple in-memory cache
const pulseCache = new Map();

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
    const url = getPolygonUrl(poly, apiKey);
    const response = await axios.get(url, { timeout: 8000 });
    const parsed   = parsePulseResponse(poly, response.data);

    if (!parsed) return res.status(404).json({ error: 'no data' });

    pulseCache.set(cacheKey, { data: parsed, ts: Date.now() });
    res.json(parsed);
  } catch (err) {
    const status = err.response?.status || 500;
    console.error('[/api/pulse]', poly, status, err.message);
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
