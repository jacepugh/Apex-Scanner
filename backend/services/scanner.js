/**
 * ScannerService — Fixed Filter Logic
 * Key fix: skip filter checks when data is missing/zero
 * rather than rejecting stocks with incomplete data
 */

const axios = require('axios');

class ScannerService {
  constructor({ cache, news }) {
    this.cache       = cache;
    this.news        = news;
    this.source      = process.env.DATA_SOURCE || 'demo';
    this.apiKey      = process.env.POLYGON_API_KEY || '';
    this.prevResults = new Map();
  }

  async scan(filters = {}) {
    const f = {
      priceMin:  parseFloat(filters.priceMin  ?? process.env.PRICE_MIN  ?? '0.50'),
      priceMax:  parseFloat(filters.priceMax  ?? process.env.PRICE_MAX  ?? '25.00'),
      volMin:    parseInt(  filters.volMin    ?? process.env.VOL_MIN    ?? '500000'),
      rvolMin:   parseFloat(filters.rvolMin   ?? process.env.RVOL_MIN   ?? '2.0'),
      gapMin:    parseFloat(filters.gapMin    ?? process.env.GAP_MIN    ?? '5.0'),
      floatMax:  parseInt(  filters.floatMax  ?? process.env.FLOAT_MAX  ?? '500000000'),
      catalyst:  filters.catalyst   === true || filters.catalyst   === 'true',
      excludeEtf:filters.excludeEtf !== false && filters.excludeEtf !== 'false',
    };

    console.log('[Scanner] Source:', this.source, '| Key set:', !!this.apiKey, '| Filters:', JSON.stringify(f));

    let stocks = [], usedDemo = false;

    try {
      if (this.source === 'polygon' && this.apiKey) {
        stocks = await this.fetchPolygonFullScan(f);
      } else if (this.source === 'finnhub' && this.apiKey) {
        stocks = await this.fetchFinnhubGainers();
      } else {
        console.warn('[Scanner] No valid source. DATA_SOURCE=' + this.source);
        stocks   = this.generateDemoData();
        usedDemo = true;
      }
    } catch (err) {
      console.error('[Scanner] Fetch error:', err.message);
      stocks   = this.generateDemoData();
      usedDemo = true;
    }

    console.log('[Scanner] Raw stocks:', stocks.length, '| demo:', usedDemo);

    // Enrich top 30 with news
    const toEnrich = stocks.slice(0, 30);
    for (const stock of toEnrich) {
      try {
        stock.news     = await this.news.getNewsForTicker(stock.ticker);
        stock.catalyst = this.classifyCatalyst(stock.news);
      } catch (e) {
        stock.news     = [];
        stock.catalyst = null;
      }
    }

    const withAlerts = this.detectAlerts(stocks);
    this.cache.set('last_scan', withAlerts, 60);
    return withAlerts;
  }

  // ─── FULL MARKET SCAN ─────────────────────────────────
  async fetchPolygonFullScan(f) {
    const cached = this.cache.get('poly_full');
    if (cached) { console.log('[Polygon] Cache hit:', cached.length); return cached; }

    console.log('[Polygon] Fetching full market snapshot...');

    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers',
        { params: { apiKey: this.apiKey, include_otc: false }, timeout: 30000 }
      );
    } catch (err) {
      if (err.response) {
        console.error('[Polygon] HTTP', err.response.status, JSON.stringify(err.response.data));
        console.log('[Polygon] Falling back to gainers...');
        return await this.fetchPolygonGainers();
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Full snapshot returned:', tickers.length, 'tickers');

    if (!tickers.length) {
      console.warn('[Polygon] Empty — trying gainers fallback...');
      return await this.fetchPolygonGainers();
    }

    const stocks = [];

    for (const t of tickers) {
      const day  = t.day     || {};
      const prev = t.prevDay || {};

      // Price — skip if no price at all
      const price = t.lastTrade?.p || day.c || day.o || 0;
      if (!price || price <= 0) continue;

      // Price range filter
      if (price < f.priceMin || price > f.priceMax) continue;

      // ETF/warrant filter
      if (f.excludeEtf && this.isEtfOrWarrant(t.ticker)) continue;

      const open      = day.o || price;
      const prevClose = prev.c || 0;
      const volume    = day.v || 0;
      const prevVol   = prev.v || 0;

      // Gap calculation — only filter if we have valid prevClose
      let gapPct = 0;
      if (prevClose > 0) {
        gapPct = ((open - prevClose) / prevClose) * 100;
      }
      // Only apply gap filter if prevClose data exists
      if (prevClose > 0 && gapPct < f.gapMin) continue;

      // Volume filter — only apply if volume data exists
      if (volume > 0 && volume < f.volMin) continue;

      // RVOL calculation — only filter if both current and prev volume exist
      let rvol = 0;
      if (prevVol > 0 && volume > 0) {
        rvol = volume / prevVol;
        if (rvol < f.rvolMin) continue;
      }

      stocks.push({
        ticker:    t.ticker,
        name:      t.ticker,
        price:     parseFloat(price.toFixed(2)),
        prevClose: parseFloat(prevClose.toFixed(2)),
        gapPct:    parseFloat(gapPct.toFixed(2)),
        change:    parseFloat((t.todaysChangePerc || 0).toFixed(2)),
        volume:    Math.floor(volume),
        rvol:      parseFloat(rvol.toFixed(2)),
        pmHigh:    parseFloat((day.h || price).toFixed(2)),
        pmLow:     parseFloat((day.l || price).toFixed(2)),
        float:     null,
        mktCap:    null,
        sector:    '',
        news:      [],
        catalyst:  null,
      });
    }

    // Sort by gap % descending, then by change % for stocks without gap data
    stocks.sort((a, b) => {
      if (b.gapPct !== a.gapPct) return b.gapPct - a.gapPct;
      return b.change - a.change;
    });

    // Return top 50
    const top = stocks.slice(0, 50);
    console.log('[Polygon] After filters:', stocks.length, '| Returning top:', top.length);

    this.cache.set('poly_full', top, 20);
    return top;
  }

  // ─── GAINERS FALLBACK ─────────────────────────────────
  async fetchPolygonGainers() {
    const cached = this.cache.get('poly_gainers');
    if (cached) { console.log('[Polygon] Gainers cache hit:', cached.length); return cached; }

    console.log('[Polygon] Fetching gainers...');
    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers',
        { params: { apiKey: this.apiKey, include_otc: false }, timeout: 15000 }
      );
    } catch (err) {
      if (err.response) {
        console.error('[Polygon] Gainers HTTP', err.response.status, JSON.stringify(err.response.data));
        throw new Error('Polygon gainers ' + err.response.status);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Gainers returned:', tickers.length);

    const stocks = tickers.map(t => {
      const day  = t.day     || {};
      const prev = t.prevDay || {};
      const price     = t.lastTrade?.p || day.c || day.o || 0;
      const prevClose = prev.c || 0;
      const gapPct    = prevClose > 0 ? ((day.o || price) - prevClose) / prevClose * 100 : 0;
      const volume    = day.v || 0;
      const prevVol   = prev.v || 0;
      const rvol      = prevVol > 0 ? volume / prevVol : 0;
      return {
        ticker:    t.ticker,
        name:      t.ticker,
        price:     parseFloat((price || 0).toFixed(2)),
        prevClose: parseFloat((prevClose || 0).toFixed(2)),
        gapPct:    parseFloat(gapPct.toFixed(2)),
        change:    parseFloat((t.todaysChangePerc || 0).toFixed(2)),
        volume:    Math.floor(volume),
        rvol:      parseFloat(rvol.toFixed(2)),
        pmHigh:    parseFloat((day.h || price).toFixed(2)),
        pmLow:     parseFloat((day.l || price).toFixed(2)),
        float:     null, mktCap: null, sector: '', news: [], catalyst: null,
      };
    }).filter(s => s.price > 0);

    this.cache.set('poly_gainers', stocks, 20);
    return stocks;
  }

  // ─── FINNHUB ──────────────────────────────────────────
  async fetchFinnhubGainers() {
    const cached = this.cache.get('fh_gainers');
    if (cached) return cached;
    const list = ['AAPL','TSLA','AMD','NVDA','AMZN','META','MSFT','GOOGL','NFLX','BABA','NIO','PLTR','SOFI','MARA','RIOT','COIN'];
    const results = await Promise.allSettled(list.map(s => this.fetchFinnhubQuote(s)));
    const stocks  = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    this.cache.set('fh_gainers', stocks, 30);
    return stocks;
  }

  async fetchFinnhubQuote(ticker) {
    const cached = this.cache.get('fhq_' + ticker);
    if (cached) return cached;
    const res = await axios.get('https://finnhub.io/api/v1/quote', {
      params: { symbol: ticker, token: this.apiKey }, timeout: 5000,
    });
    const q = res.data;
    if (!q?.c || q.c === 0) return null;
    const gapPct = q.pc > 0 ? ((q.o - q.pc) / q.pc) * 100 : 0;
    const result = {
      ticker, name: ticker, price: q.c, prevClose: q.pc,
      gapPct: parseFloat(gapPct.toFixed(2)),
      change: q.pc > 0 ? parseFloat(((q.c - q.pc) / q.pc * 100).toFixed(2)) : 0,
      volume: q.v || 0, rvol: 0, pmHigh: q.h, pmLow: q.l,
      float: null, mktCap: null, news: [], catalyst: null,
    };
    this.cache.set('fhq_' + ticker, result, 15);
    return result;
  }

  // ─── HELPERS ──────────────────────────────────────────
  isEtfOrWarrant(ticker) {
    if (!ticker) return true;
    if (ticker.length > 5) return true;
    if (/W[Ss]?$/.test(ticker)) return true;
    const etfs = ['SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK',
                  'ARKK','ARKG','ARKW','SQQQ','TQQQ','SPXL','SPXU','UVXY','VXX',
                  'VIXY','LABD','LABU','SOXL','SOXS','FNGU','FNGD','CURE','NAIL'];
    return etfs.includes(ticker.toUpperCase());
  }

  detectAlerts(stocks) {
    return stocks.map(s => {
      const prev        = this.prevResults.get(s.ticker);
      const breakingPmh = prev && !prev.breakingPmh && s.price >= s.pmHigh;
      const volumeSpike = prev && s.rvol > 8 && prev.rvol <= 8;
      const newSetup    = !prev;
      this.prevResults.set(s.ticker, { ...s, breakingPmh });
      return { ...s, breakingPmh, volumeSpike, newSetup };
    });
  }

  classifyCatalyst(newsItems = []) {
    if (!newsItems || !newsItems.length) return null;
    const text = newsItems.map(n =>
      ((n.headline || '') + ' ' + (n.summary || '')).toLowerCase()
    ).join(' ');
    if (/fda|approval|clearance|510\(k\)|breakthrough|pdufa|nda|bla/.test(text))
      return { type:'fda',      label:'FDA Approval',  class:'cat-fda',      score:9 };
    if (/earnings|revenue|eps|profit|quarterly|beat/.test(text))
      return { type:'earnings', label:'Earnings Beat', class:'cat-earnings', score:8 };
    if (/merger|acquisition|acquires|acquired|buyout|takeover/.test(text))
      return { type:'ma',       label:'M&A Deal',      class:'cat-ma',       score:8 };
    if (/contract|award|wins|selected|government|department of/.test(text))
      return { type:'contract', label:'Contract Win',  class:'cat-contract', score:7 };
    if (/partnership|collaboration|agreement|joint venture/.test(text))
      return { type:'partner',  label:'Partnership',   class:'cat-partner',  score:6 };
    if (/8-k|s-1|sec filing|offering|raise/.test(text))
      return { type:'sec',      label:'SEC Filing',    class:'cat-sec',      score:5 };
    return null;
  }

  generateDemoData() {
    console.log('[Scanner] WARNING: DEMO MODE');
    let seed = 77777;
    const r = (min, max) => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return min + ((seed >>> 0) / 0xffffffff) * (max - min);
    };
    return [
      { ticker:'DEMO1', float:4e6  },
      { ticker:'DEMO2', float:8e6  },
      { ticker:'DEMO3', float:12e6 },
      { ticker:'DEMO4', float:6e6  },
      { ticker:'DEMO5', float:20e6 },
    ].map(s => {
      const prev = r(1, 20), gap = r(5, 40), price = prev * (1 + gap / 100);
      return {
        ticker: s.ticker, name: s.ticker + ' (Demo)',
        price: parseFloat(price.toFixed(2)), prevClose: parseFloat(prev.toFixed(2)),
        gapPct: parseFloat(gap.toFixed(2)), change: parseFloat(gap.toFixed(2)),
        volume: Math.floor(r(1e6, 10e6)), rvol: parseFloat(r(3, 15).toFixed(1)),
        pmHigh: parseFloat((price * r(1.01, 1.1)).toFixed(2)),
        pmLow:  parseFloat((prev * 1.02).toFixed(2)),
        float: s.float, mktCap: null, news: [], catalyst: null,
      };
    });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ScannerService };
