/**
 * /api/scanner — Scanner endpoint
 * Reads from the scheduled wide scan store — no live scan triggered on request
 * Filters applied in-memory for instant response
 */

const express = require('express');
const router  = express.Router();
const store   = require('../services/store');

// GET /api/scanner — return filtered pool from store
router.get('/', (req, res) => {
  // Parse filter params — undefined means "no filter applied"
  const f = {
    priceMin:     req.query.priceMin     !== undefined ? parseFloat(req.query.priceMin)  : undefined,
    priceMax:     req.query.priceMax     !== undefined ? parseFloat(req.query.priceMax)  : undefined,
    gapMin:       req.query.gapMin       !== undefined ? parseFloat(req.query.gapMin)    : undefined,
    floatMax:     req.query.floatMax     !== undefined ? parseInt(req.query.floatMax)    : undefined,
    dollarVolMin: req.query.dollarVolMin !== undefined ? parseFloat(req.query.dollarVolMin) : undefined,
    floatRotMin:  req.query.floatRotMin  !== undefined ? parseFloat(req.query.floatRotMin)  : undefined,
    excludeEtf:   req.query.excludeEtf  !== 'false',
  };

  // Remove undefined keys
  Object.keys(f).forEach(k => f[k] === undefined && delete f[k]);

  try {
    const results = store.filter(f);
    res.json(results);
  } catch (err) {
    console.error('[/api/scanner] Error:', err.message);
    res.status(500).json({ error: 'Filter failed', message: err.message });
  }
});

// GET /api/scanner/pool — raw wide pool, no filters (debug/admin)
router.get('/pool', (req, res) => {
  res.json(store.get());
});

// GET /api/scanner/ticker/:symbol — single ticker news
router.get('/ticker/:symbol', async (req, res) => {
  const { news } = req.app.locals;
  const ticker = req.params.symbol.toUpperCase();
  try {
    const newsItems = await news.getNewsForTicker(ticker);
    res.json({ ticker, news: newsItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/scanner/status
router.get('/status', (req, res) => {
  res.json({
    store:     store.stats(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
