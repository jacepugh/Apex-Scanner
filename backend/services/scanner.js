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
 *
 * FILTER ARCHITECTURE (Phase 1)
 * ------------------------------
 * Three filter constant tiers:
 *
 *   POOL_FILTERS      — wide backend scan, never rendered to frontend.
 *                       Keeps the store pool large so display filters have
 *                       something to work with at read time.
 *
 *   DISPLAY_FILTERS   — frontend defaults shown to the user on first load.
 *                       Applied client-side via applyFilters() in index.html.
 *
 *   ASETUP_THRESHOLDS — criteria for the A-setup badge. Scored per-ticker
 *                       after enrichment. Null RVOL does NOT disqualify —
 *                       missing prevVol is common on the best pre-mkt plays.
 *
 * NEWS CATALYST QUALITY (Phase 2)
 * --------------------------------
 * Three gating layers applied in classifyCatalyst() before keyword matching:
 *
 *   1. Ticker relevance filter — article must mention the ticker symbol in
 *      the headline or first 300 chars of summary. Eliminates roundup articles
 *      (e.g. Benzinga "Top 20 Movers") that mention 20-30 tickers and were
 *      previously attributed as catalysts to whichever ticker was being enriched.
 *
 *   2. Recency gate — if the freshest relevant article is older than 48 hours,
 *      catalyst returns null. Prevents 700+ day old news from triggering A-setup
 *      qualification. Frontend news window display is unchanged.
 *
 *   3. Polygon insights[] sentiment gate — Polygon's /v2/reference/news returns
 *      an insights[] array per article. If an entry's sentiment field is non-null
 *      (set by news.js fetchPolygonNews when insights[] contained this ticker),
 *      the article is confirmed directly relevant — skip text relevance check.
 *      If sentiment is null, fall through to text relevance filter (covers both
 *      "ticker absent from insights[]" and Finnhub/AV fallback articles).
 *
 * classifyCatalyst() signature changed from (newsItems) to (newsItems, ticker)
 * to support relevance filtering. enrichNewsBackground passes stock.ticker.
 * aSetup re-score always runs AFTER catalyst is set.
 */

'use strict';

const axios = require('axios');

// ---------------------------------------------------------------------------
// Filter constants — Phase 1 architecture
// ---------------------------------------------------------------------------

/**
 * POOL_FILTERS — used by server.js WIDE_FILTERS.
 * Intentionally loose. Frontend filters applied at read time.
 * gapMin: 3% (not 0) to prune noise while keeping the pool wide.
 */
const POOL_FILTERS = {
  priceMin:     0.50,
  priceMax:     25.00,
  gapMin:       3,
  floatMax:     500_000_000,
  dollarVolMin: 0,
  floatRotMin:  0,
  rvolMin:      0,
  excludeEtf:   true,
};

/**
 * DISPLAY_FILTERS — defaults the frontend presents to the user.
 * Synced with STATE.filters defaults and filter drawer initial values in
 * index.html. priceMax $5 to focus on low-priced momentum setups.
 */
const DISPLAY_FILTERS = {
  priceMin:     0.50,
  priceMax:     5.00,
  gapMin:       7,
  floatMax:     50_000_000,
  dollarVolMin: 100_000,
  floatRotMin:  0,
  rvolMin:      0,
  excludeEtf:   true,
};

/**
 * ASETUP_THRESHOLDS — criteria scored per-ticker after enrichment.
 * A-setup badge fires when ALL hard criteria are met.
 * RVOL null does NOT disqualify — see file-level note.
 */
const ASETUP_THRESHOLDS = {
  gapMin:          10,          // gap > 10%
  floatMax:        20_000_000,  // float < 20M shares outstanding
  rvolMin:         5,           // RVOL > 5x (skipped when null)
  dollarVolMin:    250_000,     // dollar volume > $250K
  requireCatalyst: true,        // catalyst must be confirmed
};

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

/** Phase 2: maximum article age for catalyst classification */
const CATALYST_RECENCY_MS = 48 * 60 * 60 * 1000; // 48 hours

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
// ETF / warrant / rights blocklist — extracted to module scope to avoid
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
// A-setup scoring
// ---------------------------------------------------------------------------

/**
 * scoreASetup — scores a ticker against ASETUP_THRESHOLDS.
 * Called after enrichment so float and catalyst are populated.
 *
 * Returns { score: number, isASetup: boolean }
 *
 * score   — additive (0–5). Not currently displayed but wired up for
 *           Phase 3 ranking when multiple A-setups appear simultaneously.
 * isASetup — true only when ALL hard criteria are met.
 *
 * RVOL null rule: if prevVol was unavailable (rvol === null), the RVOL
 * criterion is treated as a soft pass rather than a disqualifier. The best
 * pre-market setups often have no prior-day volume baseline — dropping them
 * for a missing field would eliminate the highest-quality plays.
 */
function scoreASetup(s) {
  let score = 0;
  let isASetup = true;

  // Gap > threshold (hard)
  if (s.gapPct >= ASETUP_THRESHOLDS.gapMin) score++;
  else isASetup = false;

  // Float < threshold (hard — only checked when float is known)
  if (s.float != null) {
    if (s.float <= ASETUP_THRESHOLDS.floatMax) score++;
    else isASetup = false;
  }
  // float null → soft pass (enrichment may not have run yet)

  // RVOL (soft when null — see file-level note)
  if (s.rvol !== null) {
    if (s.rvol >= ASETUP_THRESHOLDS.rvolMin) score++;
    else isASetup = false;
  }
  // rvol null → neither adds nor subtracts

  // Dollar volume (hard)
  if (s.dollarVolume >= ASETUP_THRESHOLDS.dollarVolMin) score++;
  else isASetup = false;

  // Catalyst confirmed (hard)
  if (s.catalyst) score++;
  else if (ASETUP_THRESHOLDS.requireCatalyst) isASetup = false;

  return { score, isASetup };
}

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
      priceMin:     parseFloat(filters.priceMin     ?? process.env.PRICE_MIN      ?? POOL_FILTERS.priceMin),
      priceMax:     parseFloat(filters.priceMax     ?? process.env.PRICE_MAX      ?? POOL_FILTERS.priceMax),
      dollarVolMin: parseFloat(filters.dollarVolMin ?? process.env.DOLLAR_VOL_MIN ?? POOL_FILTERS.dollarVolMin),
      floatRotMin:  parseFloat(filters.floatRotMin  ?? process.env.FLOAT_ROT_MIN  ?? POOL_FILTERS.floatRotMin),
      gapMin:       parseFloat(filters.gapMin       ?? process.env.GAP_MIN        ?? POOL_FILTERS.gapMin),
      floatMax:     parseInt(  filters.floatMax     ?? process.env.FLOAT_MAX      ?? POOL_FILTERS.floatMax),
      rvolMin:      parseFloat(filters.rvolMin      ?? process.env.RVOL_MIN       ?? POOL_FILTERS.rvolMin),
      excludeEtf:   filters.excludeEtf !== false && filters.excludeEtf !== 'false',
    };

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
  // Batch size 5: conservative for Finnhub/AlphaVantage rate limits.
  // Re-scores A-setup after news enrichment since catalyst is now known.
  //
  // Phase 2: classifyCatalyst now receives stock.ticker so relevance
  // filtering, recency gating, and insights[] gating can be applied.
  // aSetup re-score MUST run after catalyst is set — ordering is intentional.
  // -------------------------------------------------------------------------
  async enrichNewsBackground(stocks) {
    const toEnrich = stocks.slice(0, 20);

    await runInBatches(toEnrich, 5, async (stock) => {
      try {
        const newsItems = await this.news.getNewsForTicker(stock.ticker);
        stock.news     = newsItems;
        stock.catalyst = this.classifyCatalyst(newsItems, stock.ticker);
      } catch (e) {
        stock.news     = [];
        stock.catalyst = null;
      }
      // Re-score A-setup now that catalyst is known.
      // Must run AFTER catalyst assignment — Phase 2 requirement.
      stock.aSetup = scoreASetup(stock);
    });

    await this._writeScanCache((cached) => {
      for (const stock of toEnrich) {
        const idx = cached.findIndex(s => s.ticker === stock.ticker);
        if (idx !== -1) {
          cached[idx].news     = stock.news;
          cached[idx].catalyst = stock.catalyst;
          cached[idx].aSetup   = stock.aSetup;
        }
      }
    });

    console.log('[Scanner] Background news enrichment complete');
  }

  // -------------------------------------------------------------------------
  // Background enrichment — floats
  // Batch size 20: Polygon Starter tolerates higher concurrency.
  // Float always comes from reference endpoint — parseTicker no longer
  // attempts snapshot fields so enrichment is the single source of truth.
  // Re-scores A-setup after float is populated.
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

      // Re-score A-setup now that float is known
      stock.aSetup = scoreASetup(stock);
    });

    await this._writeScanCache((cached) => {
      for (const stock of needFloat) {
        const idx = cached.findIndex(s => s.ticker === stock.ticker);
        if (idx !== -1) {
          cached[idx].float         = stock.float;
          cached[idx].floatRotation = stock.floatRotation;
          cached[idx].aSetup        = stock.aSetup;
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
  //
  // Phase 1 change: float fields removed from here entirely.
  // parseTicker no longer attempts t.shareClassSharesOutstanding or
  // t.weightedSharesOutstanding from the snapshot payload. Those fields are
  // unreliable on snapshot responses and were causing inconsistency between
  // tickers that happened to have them vs those that didn't.
  // enrichFloatsBackground is now the single source of truth for all floats.
  // -------------------------------------------------------------------------
  parseTicker(t, session, f) {
    if (!t.ticker) return null;

    const day  = t.day     || {};
    const prev = t.prevDay || {};

    // --- Price with staleness gate ---------------------------------------
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
    if (prevClose > 0 && f.gapMin > 0 && gapPct < f.gapMin) return null;
    if (gapPct > GAP_CAP_PCT)   return null;
    if (gapPct < GAP_FLOOR_PCT) return null;

    // --- Float & float rotation -----------------------------------------
    // Phase 1: float always null here — enrichFloatsBackground is sole owner.
    // Removed snapshot field attempt (t.shareClassSharesOutstanding etc.)
    // for consistency. All tickers start with float=null and get enriched
    // in the background pass.
    const float         = null;
    const floatRotation = null;

    if (f.floatMax > 0      && float          && float          > f.floatMax)              return null;
    if (f.floatRotMin > 0   && floatRotation  !== null && floatRotation < f.floatRotMin)   return null;

    // --- RVOL ------------------------------------------------------------
    let rvol = null;
    if (prevVol > 0 && volume > 0) rvol = parseFloat((volume / prevVol).toFixed(2));
    if (f.rvolMin > 0 && rvol !== null && rvol < f.rvolMin) return null;

    const stock = {
      ticker:        t.ticker,
      price:         parseFloat(price.toFixed(2)),
      prevClose:     parseFloat(prevClose.toFixed(2)),
      gapPct:        parseFloat(gapPct.toFixed(2)),
      gapTier:       this.getGapTier(gapPct),
      change:        prevClose > 0
                       ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2))
                       : 0,
      volume:        Math.floor(volume),
      dollarVolume:  Math.floor(dollarVolume),
      rvol,
      floatRotation,
      pmHigh:        parseFloat((day.h  > 0 ? day.h  : price).toFixed(2)),
      pmLow:         parseFloat((day.l  > 0 ? day.l  : price).toFixed(2)),
      float,                   // always null at parse time — enriched later
      session,
      news:          [],
      catalyst:      null,
      lastTradeTime: lastTradeTs || null,
      priceStale:    tradeIsStale,
    };

    // Initial A-setup score with available data (float/catalyst null at this point)
    stock.aSetup = scoreASetup(stock);

    return stock;
  }

  // -------------------------------------------------------------------------
  // ETF / warrant / rights detection
  //
  // Phase 2 addition: lowercase 'r' suffix (length >= 4) catches rights
  // offering instruments like MPTIr. Distinct from the existing uppercase 'R'
  // check which targets a different instrument class (5-char tickers only).
  // length >= 4 guard is belt-and-suspenders — no real common shares end in
  // lowercase 'r' in US equity markets.
  // -------------------------------------------------------------------------
  isEtf(ticker) {
    if (!ticker)            return true;
    if (ticker.length > 5)  return true;
    if (/W[Ss]?$/.test(ticker))                    return true;
    if (/R$/.test(ticker) && ticker.length === 5)  return true;
    if (/r$/.test(ticker) && ticker.length >= 4)   return true; // rights offerings e.g. MPTIr
    if (/U$/.test(ticker) && ticker.length === 5)  return true;
    return ETF_SET.has(ticker.toUpperCase());
  }

  // -------------------------------------------------------------------------
  // Alert detection
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
  // Catalyst classification — Phase 2
  //
  // Signature change: now accepts (newsItems, ticker) instead of (newsItems)
  // so relevance filtering can gate which articles reach keyword matching.
  //
  // Three gating layers (applied in order before regex runs):
  //
  //   Layer 1 — Polygon insights[] sentiment gate
  //     news.js sets n.sentiment when insights[] contained an entry for this
  //     ticker. Non-null sentiment = confirmed direct mention → pass through.
  //     Null sentiment falls through to Layer 2 (covers Finnhub/AV articles
  //     and Polygon articles where the ticker was absent from insights[]).
  //
  //   Layer 2 — Text relevance filter
  //     Ticker symbol must appear in the headline or first 300 chars of
  //     summary. Eliminates roundup articles that mention 20-30 tickers
  //     without being specifically about any of them.
  //
  //   Layer 3 — Recency gate
  //     After relevance filtering, check the freshest article's publishedAt.
  //     If older than CATALYST_RECENCY_MS (48h), return null. Prevents stale
  //     news from triggering catalyst badges and A-setup qualification.
  //
  // Keyword classification runs only on articles that pass all three layers.
  // -------------------------------------------------------------------------
  classifyCatalyst(newsItems = [], ticker = '') {
    if (!newsItems?.length) return null;

    const tkLower = ticker.toLowerCase();
    const now     = Date.now();

    // --- Layers 1 + 2: filter to articles confirmed relevant to this ticker ---
    const relevant = newsItems.filter(n => {
      // Layer 1: Polygon insights[] confirmation
      // n.sentiment is non-null only when fetchPolygonNews found this ticker
      // in the article's insights[] array. Trust it unconditionally.
      if (n.sentiment !== null && n.sentiment !== undefined) {
        return true;
      }

      // Layer 2: Text relevance fallback
      // Used for: Finnhub/AV articles (no insights[]), and Polygon articles
      // where insights[] was absent or didn't contain this ticker.
      if (tkLower) {
        const headline   = (n.headline || '').toLowerCase();
        const summaryPfx = (n.summary  || '').slice(0, 300).toLowerCase();
        return headline.includes(tkLower) || summaryPfx.includes(tkLower);
      }

      // No ticker provided (shouldn't happen in normal flow) — pass through
      return true;
    });

    if (!relevant.length) return null;

    // --- Layer 3: Recency gate ---
    // Find the freshest publishedAt across all relevant articles.
    // relevant[] is pre-sorted by score then date from news.js, but we want
    // the absolute newest timestamp regardless of score order.
    const freshestMs = Math.max(
      ...relevant.map(n => new Date(n.publishedAt || 0).getTime())
    );
    if (now - freshestMs > CATALYST_RECENCY_MS) {
      console.log(`[Scanner] Catalyst gated by recency for ${ticker} — freshest article ${Math.round((now - freshestMs) / 3600000)}h old`);
      return null;
    }

    // --- Keyword classification on confirmed-relevant articles only ---
    const text = relevant
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
      const stock = {
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
      stock.aSetup = scoreASetup(stock);
      return stock;
    });
  }
}

module.exports = { ScannerService, POOL_FILTERS, DISPLAY_FILTERS, ASETUP_THRESHOLDS, scoreASetup };
