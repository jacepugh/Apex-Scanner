/**
 * ScanStore — in-memory store for the scheduled wide scan result
 *
 * Single source of truth for:
 *   - The last full scan pool (up to 50 stocks)
 *   - Fast price refresh updates merged on top of pool prices
 *
 * Wiped on restart — first scheduleScan() repopulates within seconds.
 * Singleton — shared across all requires.
 */

'use strict';

class ScanStore {
  constructor() {
    this.pool           = [];    // full wide scan result
    this.timestamp      = null;  // Date of last successful discovery scan
    this.session        = null;  // market session at time of last scan
    this.scanCount      = 0;     // total discovery scans since boot

    // Price refresh state — updated by server.js on the fast cycle
    this._priceUpdates     = {};  // { ticker: { price, lastTradeTime, priceStale, updatedAt } }
    this._priceRefreshTime = null; // Date of last price refresh
  }

  // ─── Discovery scan writes ──────────────────────────────────────────────

  set(stocks, session) {
    // Keep last good pool if new result is empty — don't wipe on a bad scan
    this.pool      = stocks?.length > 0 ? stocks : this.pool;
    this.timestamp = new Date();
    this.session   = session || 'unknown';
    this.scanCount++;

    // Clear stale price updates when a fresh full scan comes in —
    // the new pool already has current prices baked in
    this._priceUpdates = {};

    console.log(
      `[Store] Scan #${this.scanCount} | ${(stocks || []).length} stocks` +
      ` | pool: ${this.pool.length} | session: ${this.session}`
    );
  }

  get() {
    // Merge latest price refresh updates on top of pool before returning.
    // Pool objects are mutated in-place by applyPriceUpdates so this is
    // effectively a no-op after the merge — kept for safety.
    return this.pool;
  }

  // ─── Price refresh writes ───────────────────────────────────────────────

  /**
   * Merge a price_update map from scanner.refreshPrices() into the pool.
   * Updates price, lastTradeTime, and priceStale in-place on matching tickers.
   * Called by server.js on the fast refresh cycle.
   *
   * @param {Object} updates  — { ticker: { price, lastTradeTime, priceStale, updatedAt } }
   */
  applyPriceUpdates(updates = {}) {
    if (!Object.keys(updates).length) return;

    for (const stock of this.pool) {
      const u = updates[stock.ticker];
      if (!u) continue;
      stock.price         = u.price;
      stock.lastTradeTime = u.lastTradeTime;
      stock.priceStale    = u.priceStale;
      // Recalculate change % with updated price so frontend shows accurate delta
      if (stock.prevClose > 0) {
        stock.change = parseFloat(((u.price - stock.prevClose) / stock.prevClose * 100).toFixed(2));
      }
    }

    this._priceUpdates     = { ...this._priceUpdates, ...updates };
    this._priceRefreshTime = new Date();
  }

  /**
   * Returns tickers currently in the pool — used by the price refresh cycle
   * to build the targeted bulk snapshot request.
   */
  getDisplayedTickers() {
    return this.pool.map(s => s.ticker).filter(Boolean);
  }

  // ─── Reads ──────────────────────────────────────────────────────────────

  /**
   * Apply frontend filters to the stored pool in-memory — no re-scan needed.
   *
   * Gap filter note: when prevClose is 0 (missing data) gapPct will be 0,
   * which would incorrectly fail a gapMin > 0 check. We skip the gap filter
   * for tickers with no prevClose baseline — same logic as parseTicker.
   */
  filter(f = {}) {
    return this.pool.filter(s => {
      if (f.priceMin !== undefined && s.price < f.priceMin) return false;
      if (f.priceMax !== undefined && s.price > f.priceMax) return false;

      // Gap filter — only enforce when prevClose is known
      if (f.gapMin !== undefined && f.gapMin > 0 && s.prevClose > 0 && s.gapPct < f.gapMin) return false;

      if (f.floatMax !== undefined && s.float && s.float > f.floatMax) return false;

      if (f.dollarVolMin !== undefined && f.dollarVolMin > 0
          && s.dollarVolume > 0 && s.dollarVolume < f.dollarVolMin) return false;

      if (f.floatRotMin !== undefined && f.floatRotMin > 0
          && s.floatRotation != null && s.floatRotation < f.floatRotMin) return false;

      // rvolMin filter — skip tickers with unknown rvol (null) rather than dropping them
      if (f.rvolMin !== undefined && f.rvolMin > 0
          && s.rvol !== null && s.rvol < f.rvolMin) return false;

      if (f.excludeEtf && s.isEtf) return false;

      return true;
    });
  }

  // ─── Stats / diagnostics ────────────────────────────────────────────────

  stats() {
    return {
      poolSize:   this.pool.length,
      timestamp:  this.timestamp?.toISOString()      || null,
      session:    this.session,
      scanCount:  this.scanCount,
      ageSeconds: this.timestamp
        ? Math.floor((Date.now() - this.timestamp) / 1000)
        : null,
    };
  }

  /**
   * Age of last price refresh in seconds — exposed on /api/health.
   * Returns null if no refresh has run yet.
   */
  priceRefreshAge() {
    return this._priceRefreshTime
      ? Math.floor((Date.now() - this._priceRefreshTime) / 1000)
      : null;
  }

  isEmpty() {
    return this.pool.length === 0;
  }
}

// Singleton — shared across all requires
module.exports = new ScanStore();
