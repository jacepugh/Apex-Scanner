'use strict';

const jwt = require('jsonwebtoken');

/**
 * requireAuth — JWT httpOnly cookie middleware
 * Applied to all /api/ routes except /api/auth/login and /api/health.
 * Reads the signed JWT from the 'sb_session' httpOnly cookie,
 * verifies against JWT_SECRET, calls next() on success or returns 401.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.sb_session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.session = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired or invalid' });
  }
}

module.exports = { requireAuth };
