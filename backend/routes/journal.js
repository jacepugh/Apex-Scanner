'use strict';

/**
 * /api/journal — Trade journal endpoint
 * Reads/writes to /app/data/trades.json on Railway persistent volume.
 *
 * Security additions (Phase 3):
 *   - POST and DELETE require valid X-CSRF-Token header matching session
 *   - File is encrypted at rest with AES-256-GCM
 *   - Decryption failure returns empty array (never crashes server)
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const router  = express.Router();

const TRADES_FILE = path.join('/app/data', 'trades.json');
const ALG         = 'aes-256-gcm';
const IV_LEN      = 12; // bytes — GCM standard
const TAG_LEN     = 16; // bytes — GCM auth tag

// ─── ENCRYPTION HELPERS ──────────────────────────────────────────────────────

function getEncKey() {
  const hex = process.env.JOURNAL_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('JOURNAL_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const key  = getEncKey();
  const iv   = crypto.randomBytes(IV_LEN);
  const ciph = crypto.createCipheriv(ALG, key, iv);
  const enc  = Buffer.concat([ciph.update(plaintext, 'utf8'), ciph.final()]);
  const tag  = ciph.getAuthTag();
  // Layout: [IV (12)] [AuthTag (16)] [Ciphertext]
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const key  = getEncKey();
  const buf  = Buffer.from(b64, 'base64');
  const iv   = buf.slice(0, IV_LEN);
  const tag  = buf.slice(IV_LEN, IV_LEN + TAG_LEN);
  const enc  = buf.slice(IV_LEN + TAG_LEN);
  const dech = crypto.createDecipheriv(ALG, key, iv);
  dech.setAuthTag(tag);
  return Buffer.concat([dech.update(enc), dech.final()]).toString('utf8');
}

// ─── FILE HELPERS ─────────────────────────────────────────────────────────────

function ensureFile() {
  const dir = path.dirname(TRADES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTrades() {
  ensureFile();
  if (!fs.existsSync(TRADES_FILE)) return [];
  try {
    const raw = fs.readFileSync(TRADES_FILE, 'utf8').trim();
    if (!raw) return [];
    const json = decrypt(raw);
    return JSON.parse(json);
  } catch (e) {
    console.error('[Journal] Decryption/parse error — returning empty:', e.message);
    return [];
  }
}

function writeTrades(trades) {
  ensureFile();
  const json = JSON.stringify(trades, null, 2);
  const enc  = encrypt(json);
  fs.writeFileSync(TRADES_FILE, enc, 'utf8');
}

// ─── CSRF HELPER ─────────────────────────────────────────────────────────────

function validateCsrf(req, res) {
  const headerToken  = req.headers['x-csrf-token'];
  const sessionToken = req.session?.csrfToken;
  if (!headerToken || !sessionToken || headerToken !== sessionToken) {
    res.status(403).json({ error: 'Invalid CSRF token' });
    return false;
  }
  return true;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// GET /api/journal — return all trades (auth already enforced by middleware)
router.get('/', (req, res) => {
  try {
    const trades = readTrades();
    res.json(trades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal — add or update trades (upsert by id)
router.post('/', (req, res) => {
  if (!validateCsrf(req, res)) return;
  try {
    const incoming = req.body;
    if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected array' });
    const existing   = readTrades();
    const existingIds = new Map(existing.map(t => [t.id, t]));
    let added = 0, updated = 0;
    for (const trade of incoming) {
      if (!trade.id) continue;
      if (existingIds.has(trade.id)) { existingIds.set(trade.id, trade); updated++; }
      else                           { existingIds.set(trade.id, trade); added++;   }
    }
    const merged = Array.from(existingIds.values())
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    writeTrades(merged);
    res.json({ ok: true, added, updated, total: merged.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/journal/:id — remove a single trade
router.delete('/:id', (req, res) => {
  if (!validateCsrf(req, res)) return;
  try {
    const trades   = readTrades();
    const filtered = trades.filter(t => t.id !== req.params.id);
    writeTrades(filtered);
    res.json({ ok: true, removed: trades.length - filtered.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
