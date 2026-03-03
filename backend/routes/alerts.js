/**
 * /api/alerts — Alert management
 */

const express = require('express');
const router  = express.Router();

const alertHistory = [];
const MAX_HISTORY  = 500;

// GET /api/alerts — get alert history
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(alertHistory.slice(-limit).reverse());
});

// POST /api/alerts — log an alert (called internally or from frontend)
router.post('/', (req, res) => {
  const { ticker, type, message, price } = req.body;
  if (!ticker || !type) return res.status(400).json({ error: 'ticker and type required' });

  const alert = { ticker, type, message, price, timestamp: new Date().toISOString() };
  alertHistory.push(alert);
  if (alertHistory.length > MAX_HISTORY) alertHistory.shift();

  // Broadcast via WebSocket
  const { broadcast } = req.app.locals;
  if (broadcast) broadcast('alert', alert);

  res.status(201).json(alert);
});

// DELETE /api/alerts — clear history
router.delete('/', (req, res) => {
  alertHistory.length = 0;
  res.json({ message: 'Alert history cleared' });
});

module.exports = router;
