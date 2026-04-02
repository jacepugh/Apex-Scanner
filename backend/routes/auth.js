'use strict';

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');

const router  = express.Router();

// Passphrase hash is computed once at startup and stored here.
// Set by initAuth() called from server.js after env vars are loaded.
let passphraseHash = null;

async function initAuth() {
  const passphrase = process.env.AUTH_PASSPHRASE;
  if (!passphrase) {
    console.warn('[Auth] WARNING: AUTH_PASSPHRASE not set — login will always fail');
    return;
  }
  passphraseHash = await bcrypt.hash(passphrase, 12);
  console.log('[Auth] Passphrase hash ready');
}

/**
 * POST /api/auth/login
 * Body: { passphrase: string }
 *
 * On success:
 *   - Sets httpOnly + Secure + SameSite=Strict JWT cookie (8h)
 *   - Returns { ok: true, csrfToken, wsToken } in body
 *
 * csrfToken — random 32-byte hex, stored in session JWT claims,
 *             must be sent as X-CSRF-Token header on mutating requests.
 *
 * wsToken   — short JWT (24h) with { ws: true } claim,
 *             passed as ?token=xxx on WebSocket upgrade URL.
 *             Separate from session JWT so WS handler can verify
 *             independently without touching cookies.
 */
router.post('/login', async (req, res) => {
  const { passphrase } = req.body || {};

  if (!passphrase || typeof passphrase !== 'string') {
    return res.status(400).json({ error: 'Passphrase required' });
  }

  if (!passphraseHash) {
    return res.status(503).json({ error: 'Auth not configured' });
  }

  const match = await bcrypt.compare(passphrase, passphraseHash);
  if (!match) {
    return res.status(401).json({ error: 'Incorrect passphrase' });
  }

  const secret     = process.env.JWT_SECRET;
  const sessionId  = crypto.randomBytes(16).toString('hex');
  const csrfToken  = crypto.randomBytes(32).toString('hex');

  // Session JWT — lives in httpOnly cookie, 8 hours
  const sessionJwt = jwt.sign(
    { sessionId, csrfToken },
    secret,
    { expiresIn: '8h' }
  );

  // WS token JWT — returned in body, 24 hours
  // Frontend passes it as ?token=xxx on WebSocket connect URL.
  const wsToken = jwt.sign(
    { sessionId, ws: true },
    secret,
    { expiresIn: '24h' }
  );

  res.cookie('sb_session', sessionJwt, {
    httpOnly: true,
    secure:   true,
    sameSite: 'strict',
    maxAge:   8 * 60 * 60 * 1000, // 8 hours in ms
  });

  return res.json({ ok: true, csrfToken, wsToken });
});

/**
 * POST /api/auth/logout
 * Clears the session cookie.
 */
router.post('/logout', (req, res) => {
  res.clearCookie('sb_session', { httpOnly: true, secure: true, sameSite: 'strict' });
  return res.json({ ok: true });
});

module.exports = { router, initAuth };
