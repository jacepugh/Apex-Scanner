/**
 * ScanStore — in-memory store for the scheduled wide scan result
 * Single source of truth for the last scan pool
 * Wiped on restart — first scheduleScan() repopulates within seconds
 */

class ScanStore {
  constructor() {
    this.pool      = [];      // full wide scan result, up to 100 stocks
    this.timestamp = null;    // Date of last successful scan
    this.session   = null;    // market session at time of scan
    this.scanCount = 0;       // total scans run since boot
  }

  set(stocks, session) {
    this.pool      = stocks || [];
    this.timestamp = new Date();
    this.session   = session || 'unknown';
    this.scanCount++;
    console.log(`[Store] Updated: ${this.pool.length} stocks | session: ${this.session} | scan #${this.scanCount}`);
  }

  get() {
    return this.pool;
  }

  // Apply frontend filters to the stored pool in-memory — no re-scan needed
  filter(f = {}) {
    return this.pool.filter(s => {
      if (f.priceMin  !== undefined && s.price < f.priceMin)  return false;
      if (f.priceMax  !== undefined && s.price > f.priceMax)  return false;
      if (f.gapMin    !== undefined && s.gapPct < f.gapMin)   return false;
      if (f.floatMax  !== undefined && s.float && s.float > f.floatMax) return false;
      if (f.dollarVolMin !== undefined && f.dollarVolMin > 0 && s.dollarVolume > 0 && s.dollarVolume < f.dollarVolMin) return false;
      if (f.floatRotMin  !== undefined && f.floatRotMin > 0 && s.floatRotation !== null && s.floatRotation !== undefined && s.floatRotation < f.floatRotMin) return false;
      if (f.excludeEtf && s.isEtf) return false;
      return true;
    });
  }

  stats() {
    return {
      poolSize:  this.pool.length,
      timestamp: this.timestamp?.toISOString() || null,
      session:   this.session,
      scanCount: this.scanCount,
      ageSeconds: this.timestamp ? Math.floor((Date.now() - this.timestamp) / 1000) : null,
    };
  }

  isEmpty() {
    return this.pool.length === 0;
  }
}

// Singleton — shared across all requires
module.exports = new ScanStore();
