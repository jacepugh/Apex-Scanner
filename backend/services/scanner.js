/**
 * ScannerService
 * Core engine that fetches market data, applies filters, and detects setups.
 * Supports: Polygon.io, Finnhub, Alpha Vantage, Demo mode
 */

const axios = require('axios');

class ScannerService {
  constructor({ cache, news }) {
    this.cache   = cache;
    this.news    = news;
    this.source  = process.env.DATA_SOURCE || 'demo';
    this.apiKey  = process.env.POLYGON_API_KEY || process.env.FINNHUB_API_KEY || '';
    this.prevResults = new Map(); // ticker → last scan result (for delta detection)
  }

  // ─── MAIN SCAN ──────────────────────────────────────────────
  async scan(filters = {}) {
    const defaultFilters = {
      priceMin:  parseFloat(process.env.PRICE_MIN  || '0.50'),
      priceMax:  parseFloat(process.env.PRICE_MAX  || '25.00'),
      volMin:    parseInt(process.env.VOL_MIN       || '1000000'),
      rvolMin:   parseFloat(process.env.RVOL_MIN    || '3.0'),
      gapMin:    parseFloat(process.env.GAP_MIN     || '5.0'),
      floatMax:  parseInt(process.env.FLOAT_MAX     || '100000000'),
    };
    const f = { ...defaultFilters, ...filters };

    let stocks = [];

    try {
      switch (this.source) {
        case 'polygon':      stocks = await this.fetchPolygon(f);      break;
        case 'finnhub':      stocks = await this.fetchFinnhub(f);      break;
        case 'alphaVantage': stocks = await this.fetchAlphaVantage(f); break;
        default:             stocks = this.generateDemoData(f);        break;
      }
    } catch (err) {
      console.error(`[Scanner] Fetch error (${this.source}):`, err.message);
      stocks = this.generateDemoData(f); // fallback to demo
    }

    // Enrich with news catalysts
    for (const stock of stocks) {
      stock.news     = await this.news.getNewsForTicker(stock.ticker);
      stock.catalyst = this.classifyCatalyst(stock.news);
    }

    // Apply final filters
    let filtered = this.applyFilters(stocks, f);

    // Detect alerts (PMH breaks, volume spikes, new setups)
    filtered = this.detectAlerts(filtered);

    // Cache results
    this.cache.set('last_scan', filtered, 60);

    return filtered;
  }

  // ─── POLYGON.IO ─────────────────────────────────────────────
  async fetchPolygon(filters) {
    const cached = this.cache.get('polygon_snapshot');
    if (cached) return cached;

    // Get all US market snapshot
    const res = await axios.get('https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers', {
      params: {
        apiKey: this.apiKey,
        include_otc: false,
      },
      timeout: 15000,
    });

    const tickers = res.data?.tickers || [];
    const stocks = [];

    for (const t of tickers) {
      const day   = t.day     || {};
      const prev  = t.prevDay || {};
      const min   = t.min     || {};

      const price    = t.lastTrade?.p || day.c || 0;
      const prevClose= prev.c || day.o || 0;
      const gapPct   = prevClose > 0 ? ((day.o - prevClose) / prevClose) * 100 : 0;
      const volume   = day.v || 0;
      const avgVol   = prev.v || volume || 1;
      const rvol     = volume / (avgVol || 1);

      stocks.push({
        ticker:    t.ticker,
        price,
        prevClose,
        gapPct,
        change:    t.todaysChangePerc || 0,
        volume,
        rvol,
        pmHigh:    day.h || price,
        pmLow:     day.l || price,
        float:     null, // requires separate Polygon call — see enrichWithFloat()
        mktCap:    null,
      });
    }

    // Enrich float data (batch, cached)
    await this.enrichWithFloat(stocks);

    this.cache.set('polygon_snapshot', stocks, 30);
    return stocks;
  }

  async enrichWithFloat(stocks) {
    // Polygon ticker details for float — batched to avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < Math.min(stocks.length, 50); i += batchSize) {
      const batch = stocks.slice(i, i + batchSize);
      await Promise.all(batch.map(async s => {
        const cacheKey = `float_${s.ticker}`;
        const cached = this.cache.get(cacheKey);
        if (cached !== undefined) { s.float = cached; return; }
        try {
          const res = await axios.get(`https://api.polygon.io/v3/reference/tickers/${s.ticker}`, {
            params: { apiKey: this.apiKey }, timeout: 5000
          });
          const d = res.data?.results;
          s.float  = d?.share_class_shares_outstanding || d?.weighted_shares_outstanding || null;
          s.mktCap = d?.market_cap || null;
          this.cache.set(cacheKey, s.float, 3600); // cache float for 1 hour
        } catch { s.float = null; }
      }));
      await this.sleep(200); // respect rate limits
    }
  }

  // ─── FINNHUB ────────────────────────────────────────────────
  async fetchFinnhub(filters) {
    const cached = this.cache.get('finnhub_scan');
    if (cached) return cached;

    // Finnhub stock screener
    const res = await axios.get('https://finnhub.io/api/v1/stock/symbol', {
      params: { exchange: 'US', token: this.apiKey },
      timeout: 15000,
    });

    const symbols = (res.data || [])
      .filter(s => s.type === 'Common Stock')
      .slice(0, 3000) // limit for speed
      .map(s => s.symbol);

    const stocks = [];
    const batchSize = 20;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(sym => this.fetchFinnhubQuote(sym))
      );
      results.forEach(r => { if (r.status === 'fulfilled' && r.value) stocks.push(r.value); });
      await this.sleep(100);
    }

    this.cache.set('finnhub_scan', stocks, 30);
    return stocks;
  }

  async fetchFinnhubQuote(ticker) {
    const cacheKey = `fh_q_${ticker}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const [quoteRes, profileRes] = await Promise.all([
      axios.get('https://finnhub.io/api/v1/quote', {
        params: { symbol: ticker, token: this.apiKey }, timeout: 5000
      }),
      axios.get('https://finnhub.io/api/v1/stock/profile2', {
        params: { symbol: ticker, token: this.apiKey }, timeout: 5000
      }),
    ]);

    const q = quoteRes.data;
    const p = profileRes.data;
    if (!q?.c) return null;

    const result = {
      ticker,
      price:    q.c,
      prevClose:q.pc,
      gapPct:   q.pc > 0 ? ((q.o - q.pc) / q.pc) * 100 : 0,
      change:   q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : 0,
      volume:   q.v || 0,
      rvol:     0, // requires avg volume calculation
      pmHigh:   q.h,
      pmLow:    q.l,
      float:    p.shareOutstanding ? p.shareOutstanding * 1e6 : null,
      mktCap:   p.marketCapitalization ? p.marketCapitalization * 1e6 : null,
      name:     p.name,
      sector:   p.finnhubIndustry,
    };

    this.cache.set(cacheKey, result, 15);
    return result;
  }

  // ─── ALPHA VANTAGE ──────────────────────────────────────────
  async fetchAlphaVantage(filters) {
    // Alpha Vantage doesn't have a scanner endpoint — use their top gainer/losers
    const cached = this.cache.get('av_scan');
    if (cached) return cached;

    const res = await axios.get('https://www.alphavantage.co/query', {
      params: { function: 'TOP_GAINERS_LOSERS', apikey: this.apiKey },
      timeout: 10000,
    });

    const gainers = res.data?.top_gainers || [];
    const stocks = gainers.map(g => ({
      ticker:    g.ticker,
      price:     parseFloat(g.price),
      prevClose: 0,
      gapPct:    parseFloat(g.change_percentage),
      change:    parseFloat(g.change_percentage),
      volume:    parseInt(g.volume),
      rvol:      0,
      pmHigh:    parseFloat(g.price),
      pmLow:     0,
      float:     null,
      mktCap:    null,
    }));

    this.cache.set('av_scan', stocks, 60);
    return stocks;
  }

  // ─── FILTERS ────────────────────────────────────────────────
  applyFilters(stocks, f) {
    return stocks.filter(s => {
      if (!s.price || s.price < f.priceMin || s.price > f.priceMax) return false;
      if (s.volume < f.volMin) return false;
      if (s.rvol > 0 && s.rvol < f.rvolMin) return false;
      if (s.gapPct < f.gapMin) return false;
      if (s.float && s.float > f.floatMax) return false;
      if (f.catalyst && !s.catalyst) return false;
      if (f.excludeEtf && this.isEtfOrWarrant(s.ticker)) return false;
      return true;
    });
  }

  isEtfOrWarrant(ticker) {
    // Warrants typically have W or WS suffix
    if (/[Ww][Ss]?$/.test(ticker)) return true;
    // Common ETF patterns
    const etfPatterns = ['SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK','ARKK','ARKG'];
    return etfPatterns.includes(ticker.toUpperCase());
  }

  // ─── ALERT DETECTION ────────────────────────────────────────
  detectAlerts(stocks) {
    return stocks.map(s => {
      const prev = this.prevResults.get(s.ticker);
      const breakingPmh = prev && !prev.breakingPmh && s.price >= s.pmHigh;
      const volumeSpike = prev && s.rvol > 10 && prev.rvol <= 10;
      const newSetup    = !prev;

      this.prevResults.set(s.ticker, { ...s, breakingPmh });

      return { ...s, breakingPmh, volumeSpike, newSetup };
    });
  }

  // ─── CATALYST CLASSIFIER ────────────────────────────────────
  classifyCatalyst(newsItems = []) {
    if (!newsItems.length) return null;

    const text = newsItems.map(n => (n.headline + ' ' + n.summary).toLowerCase()).join(' ');

    if (/fda|approval|clearance|510\(k\)|breakthrough|pdufa|nda|bla/.test(text))
      return { type: 'fda', label: 'FDA Approval', class: 'cat-fda', score: 9 };
    if (/earnings|revenue|eps|profit|quarterly|q[1-4] results|beat/.test(text))
      return { type: 'earnings', label: 'Earnings Beat', class: 'cat-earnings', score: 8 };
    if (/merger|acquisition|acquires|acquired|buyout|takeover/.test(text))
      return { type: 'ma', label: 'M&A Deal', class: 'cat-ma', score: 8 };
    if (/contract|award|wins|selected|department of|military|government/.test(text))
      return { type: 'contract', label: 'Contract Win', class: 'cat-contract', score: 7 };
    if (/partnership|collaboration|agreement|signed deal|joint venture/.test(text))
      return { type: 'partner', label: 'Partnership', class: 'cat-partner', score: 6 };
    if (/8-k|s-1|sec filing|annual report|proxy/.test(text))
      return { type: 'sec', label: 'SEC Filing', class: 'cat-sec', score: 5 };

    // Generic news present but not high-quality catalyst
    return null;
  }

  // ─── DEMO DATA ──────────────────────────────────────────────
  generateDemoData() {
    // Returns same mock data structure as real API for testing
    const DEMO = require('./demo-data');
    return DEMO.generate();
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ScannerService };
