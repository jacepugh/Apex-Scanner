/**
 * /api/journal — Trade journal endpoint
 * Reads/writes to /app/data/trades.json on Railway persistent volume
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const TRADES_FILE = path.join('/app/data', 'trades.json');

// Ensure data directory exists
function ensureFile() {
  const dir = path.dirname(TRADES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, '[]', 'utf8');
}

function readTrades() {
  ensureFile();
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  } catch(e) {
    return [];
  }
}

function writeTrades(trades) {
  ensureFile();
  fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
}

// GET /api/journal — return all trades
router.get('/', (req, res) => {
  try {
    const trades = readTrades();
    res.json(trades);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal — add or update trades (upsert by id)
router.post('/', (req, res) => {
  try {
    const incoming = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected array' });

    const existing = readTrades();
    const existingIds = new Map(existing.map(t => [t.id, t]));

    let added = 0, updated = 0;
    for (const trade of incoming) {
      if (!trade.id) continue;
      if (existingIds.has(trade.id)) {
        existingIds.set(trade.id, trade);
        updated++;
      } else {
        existingIds.set(trade.id, trade);
        added++;
      }
    }

    const merged = Array.from(existingIds.values())
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    writeTrades(merged);
    res.json({ ok: true, added, updated, total: merged.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/journal/:id — remove a single trade
router.delete('/:id', (req, res) => {
  try {
    const trades  = readTrades();
    const filtered = trades.filter(t => t.id !== req.params.id);
    writeTrades(filtered);
    res.json({ ok: true, removed: trades.length - filtered.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
