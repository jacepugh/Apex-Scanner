'use strict';

/**
 * GET /api/chart/:ticker?tf=1Min|5Min
 *
 * Always fetches 1-min bars from Alpaca (single source of truth).
 * If tf=5Min, aggregates client-side in the frontend — backend
 * always returns raw 1-min bars so overlays stay accurate.
 *
 * Response shape:
 *   bars[]        — raw 1-min OHLCV from Alpaca
 *   pmHigh/pmLow  — pre-market range (4:00–9:29am ET)
 *   openPrice     — first bar open at/after 9:30am ET
 *   orb           — { high, low, breakoutLevel, startTime, endTime }
 *   firstCandle   — { o, h, l, c, green, entryAbove } — 9:30 candle result
 *   gapAndGo      — true if gap >7% AND first candle green
 *   goNoGo        — 'GO' | 'NO-GO' | 'PENDING' verdict
 *   currentPrice  — last bar close
 *   prevClose     — from scanner store or PM bar[0].open fallback
 *   gapPct        — (pmHigh - prevClose) / prevClose * 100
 *   entryZone     — { entryLow, entryHigh, stop, target }
 *   noData        — true if Alpaca returned nothing
 */

const express      = require('express');
const router       = express.Router();
const store        = require('../services/store');
const { alpaca }   = require('../services/alpaca');

// ─── TIME HELPERS ─────────────────────────────────────────────────────────────

function toEtHour(isoStr) {
  const d   = new Date(isoStr);
  const etS = d.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const [h, m, s] = etS.split(':').map(Number);
  return h + m / 60 + s / 3600;
}

const isPremarket = isoStr => { const h = toEtHour(isoStr); return h >= 4 && h < 9.5; };
const isRegular   = isoStr => toEtHour(isoStr) >= 9.5;
// ORB window: 9:30:00 to 9:34:59 ET (first 5 one-minute candles)
const isOrbWindow = isoStr => { const h = toEtHour(isoStr); return h >= 9.5 && h < 9.5 + 5/60; };

// ─── GO/NO-GO VERDICT ────────────────────────────────────────────────────────

function calcGoNoGo({ gapPct, firstCandle, orb, pmHigh, currentPrice }) {
  const now = new Date();
  const etH = toEtHour(now.toISOString());

  // Before market open — not enough data yet
  if (etH < 9.5) return 'PENDING';

  // Needs gap >7%, first candle green, price above ORB high
  const hasGap      = gapPct && gapPct >= 7;
  const candleGreen = firstCandle?.green;
  const aboveOrb    = orb && currentPrice && currentPrice > orb.high;

  if (hasGap && candleGreen && aboveOrb) return 'GO';
  if (hasGap && candleGreen)             return 'GO';   // pre-ORB-break confirmation
  return 'NO-GO';
}

// ─── ROUTE ───────────────────────────────────────────────────────────────────

router.get('/:ticker', async (req, res) => {
  const ticker = req.params.ticker?.toUpperCase();
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  try {
    // Always fetch 1-min bars — frontend aggregates to 5-min if needed
    const bars = await alpaca.getBars(ticker, '1Min');

    if (!bars || bars.length === 0) {
      return res.json({
        ticker, bars: [], pmHigh: null, pmLow: null, openPrice: null,
        orb: null, firstCandle: null, gapAndGo: false, goNoGo: 'PENDING',
        currentPrice: null, prevClose: null, gapPct: null, entryZone: null,
        noData: true,
        message: 'No bar data from Alpaca yet — check back after 4am ET.',
      });
    }

    const pmBars      = bars.filter(b => isPremarket(b.t));
    const regularBars = bars.filter(b => isRegular(b.t));

    // ── PM High / Low ────────────────────────────────────────────────────────
    const pmHigh = pmBars.length ? Math.max(...pmBars.map(b => b.h)) : null;
    const pmLow  = pmBars.length ? Math.min(...pmBars.map(b => b.l)) : null;

    // ── Prev close — scanner store first, PM bar[0].open as fallback ─────────
    const storeMatch = (store.get() || []).find(s => s.ticker === ticker);
    const prevClose  = storeMatch?.prevClose || (pmBars.length ? pmBars[0].o : null);

    // ── Gap % ────────────────────────────────────────────────────────────────
    const gapPct = (prevClose && pmHigh)
      ? parseFloat(((pmHigh - prevClose) / prevClose * 100).toFixed(2))
      : null;

    // ── Open price ───────────────────────────────────────────────────────────
    const openPrice = regularBars.length ? regularBars[0].o : null;

    // ── ORB (first 5 one-minute candles after 9:30am ET) ────────────────────
    const orbBars = bars.filter(b => isOrbWindow(b.t));
    const orb = orbBars.length ? {
      high:           Math.max(...orbBars.map(b => b.h)),
      low:            Math.min(...orbBars.map(b => b.l)),
      breakoutLevel:  Math.max(...orbBars.map(b => b.h)),
      breakdownLevel: Math.min(...orbBars.map(b => b.l)),
      startTime:      orbBars[0].t,
      endTime:        orbBars[orbBars.length - 1].t,
    } : null;

    // ── First candle (9:30 one-minute bar) ───────────────────────────────────
    const fc = regularBars[0] || null;
    const firstCandle = fc ? {
      o:           fc.o,
      h:           fc.h,
      l:           fc.l,
      c:           fc.c,
      green:       fc.c >= fc.o,
      entryAbove:  parseFloat(fc.h.toFixed(2)), // breakout entry = above first candle high
    } : null;

    // ── Gap and Go ───────────────────────────────────────────────────────────
    const gapAndGo = !!(gapPct && gapPct >= 7 && firstCandle?.green);

    // ── Current price ────────────────────────────────────────────────────────
    const currentPrice = bars[bars.length - 1].c;

    // ── Go / No-Go verdict ───────────────────────────────────────────────────
    const goNoGo = calcGoNoGo({ gapPct, firstCandle, orb, pmHigh, currentPrice });

    // ── Entry zone (mirrors calcEntryZone on client) ─────────────────────────
    let entryZone = null;
    if (pmHigh && prevClose && pmHigh > prevClose) {
      const pmLowRef  = pmLow || prevClose;
      const entryLow  = parseFloat((pmHigh * 0.97).toFixed(2));
      const entryHigh = parseFloat((pmHigh * 1.002).toFixed(2));
      const stop      = Math.max(
        parseFloat((pmLowRef * 0.99).toFixed(2)),
        parseFloat((entryLow  * 0.97).toFixed(2))
      );
      if (stop < entryLow) {
        const risk   = entryHigh - stop;
        const target = parseFloat((entryHigh + risk * 2).toFixed(2));
        entryZone = { entryLow, entryHigh, stop, target };
      }
    }

    return res.json({
      ticker, bars, pmHigh, pmLow, openPrice,
      orb, firstCandle, gapAndGo, goNoGo,
      currentPrice, prevClose, gapPct, entryZone,
      noData: false,
    });

  } catch (err) {
    console.error(`[Chart] ${ticker}:`, err.message);
    return res.status(500).json({ error: 'Chart fetch failed', detail: err.message });
  }
});

module.exports = router;
