/**
 * /api/news — News endpoints
 */

const express = require('express');
const router  = express.Router();

// GET /api/news/:ticker
router.get('/:ticker', async (req, res) => {
  const { news } = req.app.locals;
  const ticker = req.params.ticker.toUpperCase();
  const days   = parseInt(req.query.days) || 10;
  try {
    const articles = await news.getNewsForTicker(ticker, days);
    res.json({ ticker, count: articles.length, articles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
