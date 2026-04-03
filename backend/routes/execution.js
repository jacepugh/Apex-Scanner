'use strict';

/**
 * routes/execution.js
 * REST endpoints for the Alpaca execution layer.
 *
 * GET  /api/execution/position      — current POSITION state (for exec tab init)
 * GET  /api/execution/buying-power  — pre-flight buying power check
 * POST /api/execution/buy           — place entry + initial stop
 * POST /api/execution/flatten       — manual flatten (cancel all + market sell)
 */

const express     = require('express');
const router      = express.Router();
const exec        = require('../services/alpacaExecution');
const monitor     = require('../services/orderMonitor');

// ─── GET POSITION STATE ──────────────────────────────────────────────────────

router.get('/position', (req, res) => {
  try {
    res.json(monitor.getPosition());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── BUYING POWER CHECK ───────────────────────────────────────────────────────

router.get('/buying-power', async (req, res) => {
  try {
    const data = await exec.getBuyingPower();
    res.json(data);
  } catch (e) {
    console.error('[Execution] buying-power error:', e.message);
    res.status(502).json({ error: 'Alpaca unreachable', detail: e.message });
  }
});

// ─── BUY ENTRY ───────────────────────────────────────────────────────────────

router.post('/buy', async (req, res) => {
  try {
    const pos = monitor.getPosition();
    if (pos.state !== 'IDLE') {
      return res.status(409).json({ error: 'Position already open', state: pos.state });
    }

    const { ticker, shares, stopPrice } = req.body;

    // Basic validation
    if (!ticker || !shares || !stopPrice) {
      return res.status(400).json({ error: 'ticker, shares, stopPrice required' });
    }
    if (typeof shares !== 'number' || shares < 1) {
      return res.status(400).json({ error: 'shares must be a positive integer' });
    }
    if (typeof stopPrice !== 'number' || stopPrice <= 0) {
      return res.status(400).json({ error: 'stopPrice must be > 0' });
    }

    // Buying power pre-flight
    const bp = await exec.getBuyingPower();
    // We don't know exact fill yet but use a rough check: shares * stop price * 1.05
    const roughCost = shares * stopPrice * 1.05;
    if (roughCost > bp.buyingPower) {
      return res.status(400).json({
        error:        'Insufficient buying power',
        buyingPower:  bp.buyingPower,
        estimatedCost: roughCost,
      });
    }

    // Place orders
    const { entryOrder, stopOrder } = await exec.placeEntry({ ticker, shares, stopPrice });

    // Hand off to monitor
    monitor.openTrade({
      ticker,
      totalShares:  shares,
      plannedStop:  stopPrice,
      entryOrderId: entryOrder.id,
      stopOrderId:  stopOrder.id,
    });

    res.json({
      ok:           true,
      entryOrderId: entryOrder.id,
      stopOrderId:  stopOrder.id,
      mode:         process.env.ALPACA_MODE || 'paper',
    });

  } catch (e) {
    console.error('[Execution] buy error:', e.message);
    // Surface Alpaca's error message when available
    const detail = e.response?.data?.message || e.message;
    res.status(502).json({ error: 'Order placement failed', detail });
  }
});

// ─── FLATTEN ─────────────────────────────────────────────────────────────────

router.post('/flatten', async (req, res) => {
  try {
    const pos = monitor.getPosition();
    if (pos.state === 'IDLE' || pos.state === 'CLOSED') {
      return res.json({ ok: true, alreadyClosed: true });
    }
    const result = await monitor.requestFlatten();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[Execution] flatten error:', e.message);
    const detail = e.response?.data?.message || e.message;
    res.status(502).json({ error: 'Flatten failed', detail });
  }
});

module.exports = router;
