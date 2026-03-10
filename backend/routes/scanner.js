/**
 * /api/scanner — Scanner endpoint
 */

const express = require('express');
const router  = express.Router();

// GET /api/scanner — run a scan with optional filter params
router.get('/', async (req, res) => {
  const { scanner } = req.app.locals;

  // Use ?? instead of || so that 0 values are preserved (0 is a valid filter)
  const filters = {
    priceMin:  req.query.priceMin  !== undefined ? parseFloat(req.query.priceMin)  : undefined,
    priceMax:  req.query.priceMax  !== undefined ? parseFloat(req.query.priceMax)  : undefined,
    volMin:    req.query.volMin    !== undefined ? parseInt(req.query.volMin)       : undefined,
    rvolMin:   req.query.rvolMin   !== undefined ? parseFloat(req.query.rvolMin)   : undefined,
    gapMin:    req.query.gapMin    !== undefined ? parseFloat(req.query.gapMin)    : undefined,
    floatMax:  req.query.floatMax  !== undefined ? parseInt(req.query.floatMax)    : undefined,
    catalyst:  req.query.catalyst === 'true',
    excludeEtf:req.query.excludeEtf !== 'false',
  };

  // Remove undefined keys
  Object.keys(filters).forEach(k => filters[k] === undefined && delete filters[k]);

  try {
    const results = await scanner.scan(filters);
    res.json(results);
  } catch (err) {
    console.error('[/api/scanner] Error:', err);
    res.status(500).json({ error: 'Scan failed', message: err.message });
  }
});

// GET /api/scanner/ticker/:symbol — single ticker details
router.get('/ticker/:symbol', async (req, res) => {
  const { scanner, news } = req.app.locals;
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
  const { cache } = req.app.locals;
  const lastScan  = cache.get('last_scan');
  res.json({
    lastScanCount: lastScan?.length || 0,
    cacheStats: cache.stats(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
