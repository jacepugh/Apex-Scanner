/**
 * ScannerService — Pre-Market Edition
 *
 * ARCHITECTURE OVERVIEW
 * ---------------------
 * Two scan cycles run independently (orchestrated by store.js):
 *
 *   Discovery (30s)  — full snapshot fetch + enrichment, populates last_scan cache
 *   Price refresh    — fast price-only update for displayed tickers via refreshPrices()
 *     · 10s during pre-market  (4:00–9:29am ET)
 *     · 5s  during market open (9:30–10:30am ET)
 *     · paused outside trading hours
 *
 * SORTING PRIORITY
 * ----------------
 *   1. Catalyst present (boolean — news enrichment runs in background)
 *   2. Float rotation % (volume / float — primary momentum signal)
 *   3. Raw gap %        (absolute, not tiered — preserves precision within tier)
 *
 * GAP TIERS (display labels only — do not affect sort order)
 *   Tier 1: 5–15%   normal
 *   Tier 2: 15–30%  strong
 *   Tier 3: 30%+    explosive
 *
 * FLOAT DATA NOTE
 * ---------------
 * Polygon's reference endpoint returns `share_class_shares_outstanding` and
 * `weighted_shares_outstanding` — these are shares OUTSTANDING, not public float.
 * True float is typically 60–85% of shares outstanding (after subtracting insider
 * and institutional lockups). All float-based filters and floatRotation values
 * should be treated as approximate. A ticker showing 8M shares outstanding may
 * have a true float closer to 5M.
 * TODO: replace with a dedicated float data source in a future phase.
 */

'use strict';

const axios = require('axios');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Skip lastTrade price if older than this — fall back to bid/ask mid */
const STALE_TRADE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Gap sanity ceiling. Anything above this is almost certainly a data error,
 * halt artifact, or reverse-split anomaly — not a tradeable setup.
 */
const GAP_CAP_PCT   = 200;
const GAP_FLOOR_PCT = -80;

/** Minimum dollar volume to bother parsing a ticker at all */
const DOLLAR_VOL_FLOOR = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run async tasks in batches to bound concurrency.
 * Replaces both sequential for-loops and unbounded Promise.all.
 *
 * @param {Array}    items
 * @param {number}   batchSize
 * @param {Function} asyncFn   — receives one item, returns a Promise
 */
async function runInBatches(items, batchSize, asyncFn) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(asyncFn));
  }
}

// ---------------------------------------------------------------------------
// Sort function — catalyst → float rotation → gap %
// ---------------------------------------------------------------------------
const SORT_FN = (a, b) => {
  const catA = a.catalyst ? 1 : 0;
  const catB = b.catalyst ? 1 : 0;
  if (catB !== catA) return catB - catA;
  const rotA = a.floatRotation || 0;
  const rotB = b.floatRotation || 0;
  if (rotB !== rotA) return rotB - rotA;
  return b.gapPct - a.gapPct;
};

// ---------------------------------------------------------------------------
// ETF / warrant blocklist — extracted to module scope to avoid
// re-instantiating on every parseTicker call
// ---------------------------------------------------------------------------
const ETF_SET = new Set([
  'SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK',
  'ARKK','ARKG','ARKW','SQQQ','TQQQ','SPXL','SPXU','UVXY','VXX',
  'VIXY','LABD','LABU','SOXL','SOXS','FNGU','FNGD','CURE','NAIL',
  'UPRO','SPXS','TECL','TECS','UDOW','SDOW','TNA','TZA','FAS','FAZ',
  'BOIL','KOLD','GUSH','DRIP','DUST','JNUG','NUGT','JDST','DGAZ',
  'UGAZ','UCO','SCO','BITI','BITO','MSTU','MSTX','NVDL','TSLL',
  'ACTS','DFAC','DFAS','DFAU','DFAX','AVUV','AVLV','AVDV',
]);

// ---------------------------------------------------------------------------
// ScannerService
// ---------------------------------------------------------------------------

class ScannerService {
  constructor({ cache, news }) {
    this.cache       = cache;
    this.news        = news;
    this.source      = process.env.DATA_SOURCE || 'demo';
    this.apiKey      = process.env.POLYGON_API_KEY || '';
    this.prevResults = new Map();

    // Mutex for last_scan cache writes.
    // enrichNewsBackground and enrichFloatsBackground both fire concurrently
    // and both write back to the same cache key. Without serialization the
    // second writer clobbers the first writer's updates.
    this._enrichLock  = false;
    this._enrichQueue = [];
  }

  // -------------------------------------------------------------------------
  // Market session
  // -------------------------------------------------------------------------

  getMarketSession() {
    const now  = new Date();
    const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
    const min  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
    const mins = hour * 60 + min;
    if (mins >= 240  && mins < 570)  return 'premarket';
    if (mins >= 570  && mins < 960)  return 'regular';
    if (mins >= 960  && mins < 1200) return 'afterhours';
    return 'closed';
  }

  // -------------------------------------------------------------------------
  // Serialized cache write helper
  // Queues concurrent enrichment writes so they don't race each other.
  // updateFn receives the live cached array and mutates it in place before
  // the helper re-sorts and writes it back.
  // -------------------------------------------------------------------------
  async _writeScanCache(updateFn) {
    return new Promise((resolve) => {
      const attempt = async () => {
        if (this._enrichLock) {
          this._enrichQueue.push(attempt);
          return;
        }
        this._enrichLock = true;
        try {
          const cached = this.cache.get('last_scan');
          if (cached) {
            updateFn(cached);
            cached.sort(SORT_FN);
            this.cache.set('last_scan', cached, 60);
          }
        } finally {
          this._enrichLock = false;
          if (this._enrichQueue.length) {
            const next = this._enrichQueue.shift();
            next();
          }
          resolve();
        }
      };
      attempt();
    });
  }

  // -------------------------------------------------------------------------
  // Fast price refresh
  // Called by store.js scheduler on the fast cycle (5s market / 10s pre-mkt).
  // One API call regardless of ticker count — does NOT trigger enrichment.
  // Returns { ticker: { price, lastTradeTime, priceStale, updatedAt } }
  // -------------------------------------------------------------------------
  async refreshPrices(tickers = []) {
    if (!tickers.length || !this.apiKey) return {};
    const session = this.getMarketSession();
    try {
      const res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers',
        {
          params:  { apiKey: this.apiKey, tickers: tickers.join(','), include_otc: false },
          timeout: 8000,
        }
      );
      const updates = {};
      const now     = Date.now();

      for (const t of (res.data?.tickers || [])) {
        if (!t.ticker) continue;
        const lastTradeTs    = t.lastTrade?.t ? Math.floor(t.lastTrade.t / 1e6) : 0;
        const tradeIsStale   = lastTradeTs ? (now - lastTradeTs) > STALE_TRADE_MS : true;
        const lastTradePrice = (!tradeIsStale && t.lastTrade?.p) ? t.lastTrade.p : 0;
        const bid            = t.lastQuote?.p || 0;
        const ask            = t.lastQuote?.P || 0;
        const midpoint       = (bid > 0 && ask > 0) ? (bid + ask) / 2 : 0;

        let price = 0;
        if (session === 'premarket' || session === 'afterhours') {
          price = lastTradePrice || midpoint || ask || t.day?.c || t.prevDay?.c || 0;
        } else {
          price = t.day?.c || lastTradePrice || midpoint || t.prevDay?.c || 0;
        }

        if (price > 0) {
          updates[t.ticker] = {
            price:         parseFloat(price.toFixed(2)),
            lastTradeTime: lastTradeTs || null,
            priceStale:    tradeIsStale,
            updatedAt:     now,
          };
        }
      }
      return updates;
    } catch (err) {
      console.error('[Scanner] refreshPrices error:', err.message);
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // Main scan entry point
  // -------------------------------------------------------------------------
  async scan(filters = {}) {
    const f = {
      priceMin:     parseFloat(filters.priceMin     ?? process.env.PRICE_MIN      ?? '0.50'),
      priceMax:     parseFloat(filters.priceMax     ?? process.env.PRICE_MAX      ?? '25.00'),
      dollarVolMin: parseFloat(filters.dollarVolMin ?? process.env.DOLLAR_VOL_MIN ?? '0'),
      floatRotMin:  parseFloat(filters.floatRotMin  ?? process.env.FLOAT_ROT_MIN  ?? '0'),
      gapMin:       parseFloat(filters.gapMin       ?? process.env.GAP_MIN        ?? '0'),
      floatMax:     parseInt(  filters.floatMax     ?? process.env.FLOAT_MAX      ?? '50000000'),
      rvolMin:      parseFloat(filters.rvolMin      ?? process.env.RVOL_MIN       ?? '0'),
      excludeEtf:   filters.excludeEtf !== false && filters.excludeEtf !== 'false',
    };
    // Removed: volMin (share count) — dollarVolMin is the enforced floor.
    // Removed: catalyst filter — catalyst is assigned during background
    //   enrichment and is unknowable at parse time.

    const session = this.getMarketSession();
    console.log('[Scanner] Session:', session, '| Source:', this.source, '| Key:', !!this.apiKey);
    console.log('[Scanner] Filters:', JSON.stringify(f));

    let stocks = [], usedDemo = false;

    try {
      if (this.source === 'polygon' && this.apiKey) {
        if (session === 'premarket' || session === 'afterhours') {
          console.log('[Scanner] Extended hours — using gainers endpoint for real prices');
          stocks = await this.fetchPolygonGainers(f, session);
          if (stocks.length < 10) {
            console.log('[Scanner] Gainers thin, supplementing with snapshot...');
            const snap     = await this.fetchPolygonSnapshot(f, session);
            const existing = new Set(stocks.map(s => s.ticker));
            snap.forEach(s => { if (!existing.has(s.ticker)) stocks.push(s); });
          }
        } else {
          stocks = await this.fetchPolygonSnapshot(f, session);
        }
      } else {
        console.warn('[Scanner] No valid source — using demo data');
        stocks   = this.generateDemoData();
        usedDemo = true;
      }
    } catch (err) {
      console.error('[Scanner] Fetch error:', err.message);
      stocks   = this.generateDemoData();
      usedDemo = true;
    }

    console.log('[Scanner] Raw stocks after filtering:', stocks.length, '| demo:', usedDemo);

    const withAlerts = this.detectAlerts(stocks);
    this.cache.set('last_scan', withAlerts, 60);

    if (!usedDemo) {
      // Both enrichment jobs fire concurrently.
      // _writeScanCache serializes their cache writes so they don't clobber
      // each other when they finish at different times.
      this.enrichNewsBackground(withAlerts);
      this.enrichFloatsBackground(withAlerts);
    }

    return withAlerts;
  }

  // -------------------------------------------------------------------------
  // Background enrichment — news
  // Batch size 5: conservative for Finnhub/AlphaVantage rate limits
  // -------------------------------------------------------------------------
  async enrichNewsBackground(stocks) {
    const toEnrich = stocks.slice(0, 20);

    await runInBatches(toEnrich, 5, async (stock) => {
      try {
        const newsItems = await this.news.getNewsForTicker(stock.ticker);
        stock.news     = newsItems;
        stock.catalyst = this.classifyCatalyst(newsItems);
      } catch (e) {
        stock.news     = [];
        stock.catalyst = null;
      }
    });

    await this._writeScanCache((cached) => {
      for (const stock of toEnrich) {
        const idx = cached.findIndex(s => s.ticker === stock.ticker);
        if (idx !== -1) {
          cached[idx].news     = stock.news;
          cached[idx].catalyst = stock.catalyst;
        }
      }
    });

    console.log('[Scanner] Background news enrichment complete');
  }

  // -------------------------------------------------------------------------
  // Background enrichment — floats
  // Batch size 20: Polygon Starter tolerates higher concurrency
  // -------------------------------------------------------------------------
  async enrichFloatsBackground(stocks) {
    const needFloat = stocks.filter(s => !s.float);
    if (!needFloat.length) return;
    console.log('[Scanner] Float enrichment: fetching', needFloat.length, 'tickers');

    await runInBatches(needFloat, 20, async (stock) => {
      try {
        const cacheKey = 'float_' + stock.ticker;
        const cached   = this.cache.get(cacheKey);
        if (cached !== undefined) {
          stock.float = cached;
        } else {
          const res     = await axios.get(
            `https://api.polygon.io/v3/reference/tickers/${stock.ticker}`,
            { params: { apiKey: this.apiKey }, timeout: 8000 }
          );
          const details = res.data?.results || {};
          // shares outstanding proxy — see FLOAT DATA NOTE at top of file
          const float   = details.share_class_shares_outstanding
                       || details.weighted_shares_outstanding
                       || null;
          this.cache.set(cacheKey, float, 86400);
          stock.float = float;
        }
        if (stock.float && stock.float > 0 && stock.volume > 0) {
          stock.floatRotation = parseFloat(((stock.volume / stock.float) * 100).toFixed(2));
        }
      } catch (e) { /* leave null — don't drop the ticker */ }
    });

    await this._writeScanCache((cached) => {
      for (const stock of needFloat) {
        const idx = cached.findIndex(s => s.ticker === stock.ticker);
        if (idx !== -1) {
          cached[idx].float         = stock.float;
          cached[idx].floatRotation = stock.floatRotation;
        }
      }
    });

    console.log('[Scanner] Float enrichment complete');
  }

  // -------------------------------------------------------------------------
  // Polygon — full snapshot (regular hours primary)
  // -------------------------------------------------------------------------
  async fetchPolygonSnapshot(f, session) {
    const cacheKey = 'poly_snap_' + session;
    const cached   = this.cache.get(cacheKey);
    if (cached) { console.log('[Polygon] Cache hit:', cached.length, 'stocks'); return cached; }

    console.log('[Polygon] Fetching full snapshot for session:', session);
    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers',
        { params: { apiKey: this.apiKey, include_otc: false }, timeout: 30000 }
      );
    } catch (err) {
      if (err.response) {
        console.error('[Polygon] HTTP', err.response.status);
        return await this.fetchPolygonGainers(f, session);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Snapshot returned:', tickers.length, 'raw tickers');
    if (!tickers.length) return await this.fetchPolygonGainers(f, session);

    const stocks = [];
    for (const t of tickers) {
      try {
        const s = this.parseTicker(t, session, f);
        if (s) stocks.push(s);
      } catch (e) { /* skip malformed ticker */ }
    }

    stocks.sort(SORT_FN);
    const top = stocks.slice(0, 50);
    console.log('[Polygon] After filters:', stocks.length, '| Returning top:', top.length);
    this.cache.set(cacheKey, top, session === 'regular' ? 20 : 60);
    return top;
  }

  // -------------------------------------------------------------------------
  // Polygon — gainers endpoint (pre/afterhours primary)
  // -------------------------------------------------------------------------
  async fetchPolygonGainers(f = {}, session = 'regular') {
    const cacheKey = 'poly_gainers_' + session;
    const cached   = this.cache.get(cacheKey);
    if (cached) { console.log('[Polygon] Gainers cache hit:', cached.length); return cached; }

    console.log('[Polygon] Fetching gainers for session:', session);
    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers',
        { params: { apiKey: this.apiKey, include_otc: false }, timeout: 15000 }
      );
    } catch (err) {
      if (err.response) throw new Error('Polygon gainers HTTP ' + err.response.status);
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Gainers returned:', tickers.length, 'raw tickers');

    const stocks = tickers
      .map(t => { try { return this.parseTicker(t, session, f); } catch (e) { return null; } })
      .filter(Boolean);

    stocks.sort(SORT_FN);
    console.log('[Polygon] Gainers after parse:', stocks.length,
      '| top:', stocks[0]?.ticker, (stocks[0]?.gapPct ?? '') + '%');

    this.cache.set(cacheKey, stocks, session === 'premarket' ? 30 : 20);
    return stocks;
  }

  // -------------------------------------------------------------------------
  // Gap tier — display label only, does not affect sort order
  // -------------------------------------------------------------------------
  getGapTier(gapPct) {
    if (gapPct >= 30) return 3; // explosive
    if (gapPct >= 15) return 2; // strong
    if (gapPct >= 5)  return 1; // normal
    return 0;
  }

  // -------------------------------------------------------------------------
  // Core ticker parser
  // -------------------------------------------------------------------------
  parseTicker(t, session, f) {
    if (!t.ticker) return null;

    const day  = t.day     || {};
    const prev = t.prevDay || {};

    // --- Price with staleness gate ---------------------------------------
    // Polygon lastTrade.t is nanoseconds — divide by 1e6 to get ms.
    // If the last trade is older than STALE_TRADE_MS, zero it out and let
    // the fallback chain reach bid/ask mid. Prevents stale prints from
    // driving incorrect gap calculations during slow pre-market periods.
    const now          = Date.now();
    const lastTradeTs  = t.lastTrade?.t ? Math.floor(t.lastTrade.t / 1e6) : 0;
    const tradeIsStale = lastTradeTs ? (now - lastTradeTs) > STALE_TRADE_MS : true;
    const lastTradePx  = (!tradeIsStale && t.lastTrade?.p) ? t.lastTrade.p : 0;

    const bid      = t.lastQuote?.p || 0;
    const ask      = t.lastQuote?.P || 0;
    const midpoint = (bid > 0 && ask > 0) ? (bid + ask) / 2 : 0;
    const prevClose = prev.c || 0;
    const dayClose  = day.c  || 0;
    const dayOpen   = day.o  || 0;

    // Cascade: fresh lastTrade → bid/ask mid → day close → day open → prev close
    let price = 0;
    if (session === 'premarket' || session === 'afterhours') {
      price = lastTradePx || midpoint || ask || dayClose || dayOpen || prevClose;
    } else {
      price = dayClose || lastTradePx || dayOpen || midpoint || prevClose;
    }

    // Last resort: reconstruct from prev close + today's change
    if (!price && prevClose > 0 && t.todaysChange) {
      price = prevClose + t.todaysChange;
    }

    if (!price || price <= 0)                      return null;
    if (price < f.priceMin || price > f.priceMax)  return null;
    if (f.excludeEtf && this.isEtf(t.ticker))      return null;

    const volume       = day.v || 0;
    const prevVol      = prev.v || 0;
    const dollarVolume = price * volume;

    if (dollarVolume > 0 && dollarVolume < DOLLAR_VOL_FLOOR) return null;
    if (f.dollarVolMin > 0 && dollarVolume < f.dollarVolMin)  return null;

    // --- Gap calculation -------------------------------------------------
    let gapPct = 0;
    if (t.todaysChangePerc != null && t.todaysChangePerc !== 0) {
      gapPct = t.todaysChangePerc;
    } else if (prevClose > 0) {
      const ref = (session === 'premarket' || session === 'afterhours')
        ? price
        : (dayOpen > 0 ? dayOpen : price);
      gapPct = ((ref - prevClose) / prevClose) * 100;
    }

    // Gap filter — only enforced when prevClose is known.
    // When prevClose = 0 we have no baseline so we leave the ticker in the
    // pool rather than silently dropping it.
    if (prevClose > 0 && f.gapMin > 0 && gapPct < f.gapMin) return null;
    if (gapPct > GAP_CAP_PCT)   return null;
    if (gapPct < GAP_FLOOR_PCT) return null;

    // --- Float & float rotation -----------------------------------------
    // See FLOAT DATA NOTE at top of file.
    const float = t.shareClassSharesOutstanding
               || t.weightedSharesOutstanding
               || null;

    const floatRotation = (float && float > 0 && volume > 0)
      ? parseFloat(((volume / float) * 100).toFixed(2))
      : null;

    if (f.floatMax > 0      && float          && float          > f.floatMax)     return null;
    if (f.floatRotMin > 0   && floatRotation  !== null && floatRotation < f.floatRotMin) return null;

    // --- RVOL ------------------------------------------------------------
    // null = unknown (prevVol unavailable). Filter skips unknown values
    // rather than dropping the ticker.
    let rvol = null;
    if (prevVol > 0 && volume > 0) rvol = parseFloat((volume / prevVol).toFixed(2));
    if (f.rvolMin > 0 && rvol !== null && rvol < f.rvolMin) return null;

    return {
      ticker:        t.ticker,
      price:         parseFloat(price.toFixed(2)),
      prevClose:     parseFloat(prevClose.toFixed(2)),
      gapPct:        parseFloat(gapPct.toFixed(2)),
      gapTier:       this.getGapTier(gapPct),  // display label only
      change:        prevClose > 0
                       ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
                       : 0,
      volume:        Math.floor(volume),
      dollarVolume:  Math.floor(dollarVolume),
      rvol,                    // null = unknown
      floatRotation,           // null = unknown
      pmHigh:        parseFloat((day.h  > 0 ? day.h  : price).toFixed(2)),
      pmLow:         parseFloat((day.l  > 0 ? day.l  : price).toFixed(2)),
      float,                   // shares outstanding proxy — see file-level note
      session,
      news:          [],
      catalyst:      null,     // populated by enrichNewsBackground
      lastTradeTime: lastTradeTs || null,  // ms epoch — read by staleness indicator
      priceStale:    tradeIsStale,         // true if lastTrade > 15 min old
    };
  }

  // -------------------------------------------------------------------------
  // ETF / warrant detection
  // -------------------------------------------------------------------------
  isEtf(ticker) {
    if (!ticker)            return true;
    if (ticker.length > 5)  return true;
    if (/W[Ss]?$/.test(ticker))                    return true;
    if (/R$/.test(ticker) && ticker.length === 5)  return true;
    if (/U$/.test(ticker) && ticker.length === 5)  return true;
    return ETF_SET.has(ticker.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Alert detection
  // PMH tracking is single-scan only here. Cross-scan cooldown is handled
  // by pmHighBreaks map in store.js (Phase 4).
  // -------------------------------------------------------------------------
  detectAlerts(stocks) {
    return stocks.map(s => {
      const prev        = this.prevResults.get(s.ticker);
      const breakingPmh = prev && !prev.breakingPmh && s.price >= s.pmHigh;
      const volumeSpike = prev
        && s.dollarVolume > 0
        && prev.dollarVolume > 0
        && s.dollarVolume >= prev.dollarVolume * 2;
      const newSetup = !prev;
      this.prevResults.set(s.ticker, { ...s, breakingPmh });
      return { ...s, breakingPmh, volumeSpike, newSetup };
    });
  }

  // -------------------------------------------------------------------------
  // Catalyst classification
  // -------------------------------------------------------------------------
  classifyCatalyst(newsItems = []) {
    if (!newsItems?.length) return null;
    const text = newsItems
      .map(n => ((n.headline || '') + ' ' + (n.summary || '')).toLowerCase())
      .join(' ');

    if (/fda|approval|clearance|510\(k\)|breakthrough|pdufa|nda|bla/.test(text))
      return { type: 'fda',      label: 'FDA Approval',  class: 'cat-fda',      score: 9 };
    if (/earnings|revenue|eps|profit|quarterly|beat/.test(text))
      return { type: 'earnings', label: 'Earnings Beat', class: 'cat-earnings', score: 8 };
    if (/merger|acquisition|acquires|acquired|buyout|takeover/.test(text))
      return { type: 'ma',       label: 'M&A Deal',      class: 'cat-ma',       score: 8 };
    if (/contract|award|wins|selected|government|department of/.test(text))
      return { type: 'contract', label: 'Contract Win',  class: 'cat-contract', score: 7 };
    if (/partnership|collaboration|agreement|joint venture/.test(text))
      return { type: 'partner',  label: 'Partnership',   class: 'cat-partner',  score: 6 };
    if (/8-k|s-1|sec filing|offering|raise|uplist/.test(text))
      return { type: 'sec',      label: 'SEC Filing',    class: 'cat-sec',      score: 5 };
    return null;
  }

  // -------------------------------------------------------------------------
  // Demo data — used when no API key is configured
  // -------------------------------------------------------------------------
  generateDemoData() {
    console.log('[Scanner] WARNING: DEMO MODE — no real market data');
    let seed = 77777;
    const r = (min, max) => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return min + ((seed >>> 0) / 0xffffffff) * (max - min);
    };
    return [
      { ticker: 'DEMO1', float: 4e6,  floatRotPct: 28 },
      { ticker: 'DEMO2', float: 8e6,  floatRotPct: 12 },
      { ticker: 'DEMO3', float: 12e6, floatRotPct: 6  },
      { ticker: 'DEMO4', float: 6e6,  floatRotPct: 35 },
      { ticker: 'DEMO5', float: 20e6, floatRotPct: 4  },
    ].map(s => {
      const prev   = r(1, 20);
      const gap    = r(5, 45);
      const price  = prev * (1 + gap / 100);
      const volume = Math.floor(s.float * (s.floatRotPct / 100));
      const gapPct = parseFloat(gap.toFixed(2));
      return {
        ticker:        s.ticker,
        price:         parseFloat(price.toFixed(2)),
        prevClose:     parseFloat(prev.toFixed(2)),
        gapPct,
        gapTier:       this.getGapTier(gapPct),
        change:        gapPct,
        volume,
        dollarVolume:  Math.floor(price * volume),
        rvol:          parseFloat(r(1, 5).toFixed(1)),
        floatRotation: s.floatRotPct,
        pmHigh:        parseFloat((price * r(1.01, 1.1)).toFixed(2)),
        pmLow:         parseFloat((prev * 1.02).toFixed(2)),
        float:         s.float,
        session:       'demo',
        news:          [],
        catalyst:      null,
        lastTradeTime: null,
        priceStale:    false,
      };
    });
  }
}

module.exports = { ScannerService };
