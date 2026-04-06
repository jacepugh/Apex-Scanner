const express = require('express');
const router  = express.Router();

router.get('/equity', async (req, res) => {
  try {
    const live    = (process.env.ALPACA_MODE || 'paper').toLowerCase() === 'live';
    const baseUrl = live
      ? 'https://api.alpaca.markets'
      : 'https://paper-api.alpaca.markets';

    const r = await fetch(`${baseUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY,
        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
      },
    });

    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).json({ error: txt });
    }

    const data = await r.json();
    return res.json({
      equity:       parseFloat(data.equity),
      cash:         parseFloat(data.cash),
      buyingPower:  parseFloat(data.buying_power),
      mode:         live ? 'live' : 'paper',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
