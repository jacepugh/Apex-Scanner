/**
 * ScannerService — Fixed with better error logging
 * Demo data now uses DEMO1/DEMO2 tickers so you always
 * know when real vs demo data is showing
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
      priceMin: parseFloat(process.env.PRICE_MIN || '0.50'),
      priceMax: parseFloat(process.env.PRICE_MAX || '25.00'),
      volMin:   parseInt(process.env.VOL_MIN      || '500000'),
      rvolMin:  parseFloat(process.env.RVOL_MIN   || '2.0'),
      gapMin:   parseFloat(process.env.GAP_MIN    || '5.0'),
      floatMax: parseInt(process.env.FLOAT_MAX    || '500000000'),
      ...filters,
    };

    console.log('[Scanner] Source:', this.source, '| Key set:', !!this.apiKey);

    let stocks = [], usedDemo = false;

    try {
      if (this.source === 'polygon' && this.apiKey) {
        stocks = await this.fetchPolygonGainers();
      } else if (this.source === 'finnhub' && this.apiKey) {
        stocks = await this.fetchFinnhubGainers();
      } else {
        console.warn('[Scanner] No API key/source. DATA_SOURCE=' + this.source + ' KEY=' + (this.apiKey ? 'SET' : 'MISSING'));
        stocks = this.generateDemoData();
        usedDemo = true;
      }
    } catch (err) {
      console.error('[Scanner] Fetch failed:', err.message);
      stocks = this.generateDemoData();
      usedDemo = true;
    }

    console.log('[Scanner] Got', stocks.length, 'stocks | demo:', usedDemo);

    for (const stock of stocks) {
      try {
        stock.news     = await this.news.getNewsForTicker(stock.ticker);
        stock.catalyst = this.classifyCatalyst(stock.news);
      } catch (e) {
        stock.news = []; stock.catalyst = null;
      }
    }

    const filtered = usedDemo ? stocks : this.applyFilters(stocks, f);
    console.log('[Scanner] After filters:', filtered.length);
    const result = this.detectAlerts(filtered);
    this.cache.set('last_scan', result, 60);
    return result;
  }

  async fetchPolygonGainers() {
    const cached = this.cache.get('poly_gainers');
    if (cached) { console.log('[Polygon] Cache hit:', cached.length); return cached; }
    console.log('[Polygon] Fetching gainers...');
    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/gainers',
        { params: { apiKey: this.apiKey, include_otc: false }, timeout: 15000 }
      );
    } catch (err) {
      if (err.response) {
        console.error('[Polygon] HTTP', err.response.status, JSON.stringify(err.response.data));
        throw new Error('Polygon ' + err.response.status);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Tickers returned:', tickers.length);

    const stocks = tickers.map(t => {
      const day = t.day || {}, prev = t.prevDay || {};
      const price     = t.lastTrade?.p || day.c || day.o || 0;
      const prevClose = prev.c || 0;
      const gapPct    = prevClose > 0 ? ((day.o || price) - prevClose) / prevClose * 100 : 0;
      const volume    = day.v || 0;
      const prevVol   = prev.v || 1;
      return {
        ticker: t.ticker, name: t.ticker,
        price:     parseFloat((price || 0).toFixed(2)),
        prevClose: parseFloat((prevClose || 0).toFixed(2)),
        gapPct:    parseFloat(gapPct.toFixed(2)),
        change:    parseFloat((t.todaysChangePerc || 0).toFixed(2)),
        volume:    Math.floor(volume),
        rvol:      parseFloat((prevVol > 0 ? volume / prevVol : 1).toFixed(2)),
        pmHigh:    parseFloat((day.h || price).toFixed(2)),
        pmLow:     parseFloat((day.l || price).toFixed(2)),
        float: null, mktCap: null, sector: '', news: [], catalyst: null,
      };
    }).filter(s => s.price > 0);

    console.log('[Polygon] Mapped:', stocks.length);
    this.cache.set('poly_gainers', stocks, 20);
    return stocks;
  }

  async fetchFinnhubGainers() {
    const cached = this.cache.get('fh_gainers');
    if (cached) return cached;
    const list = ['AAPL','TSLA','AMD','NVDA','AMZN','META','MSFT','GOOGL','NFLX','BABA','NIO','PLTR','SOFI','MARA','RIOT','COIN'];
    const results = await Promise.allSettled(list.map(s => this.fetchFinnhubQuote(s)));
    const stocks = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    this.cache.set('fh_gainers', stocks, 30);
    return stocks;
  }

  async fetchFinnhubQuote(ticker) {
    const cached = this.cache.get('fhq_' + ticker);
    if (cached) return cached;
    const res = await axios.get('https://finnhub.io/api/v1/quote', { params: { symbol: ticker, token: this.apiKey }, timeout: 5000 });
    const q = res.data;
    if (!q?.c || q.c === 0) return null;
    const gapPct = q.pc > 0 ? ((q.o - q.pc) / q.pc) * 100 : 0;
    const result = { ticker, name: ticker, price: q.c, prevClose: q.pc, gapPct: parseFloat(gapPct.toFixed(2)), change: q.pc > 0 ? parseFloat(((q.c - q.pc) / q.pc * 100).toFixed(2)) : 0, volume: q.v || 0, rvol: 0, pmHigh: q.h, pmLow: q.l, float: null, mktCap: null, news: [], catalyst: null };
    this.cache.set('fhq_' + ticker, result, 15);
    return result;
  }

  applyFilters(stocks, f) {
    return stocks.filter(s => {
      if (!s.price || s.price < f.priceMin || s.price > f.priceMax) return false;
      if (s.volume > 0 && s.volume < f.volMin) return false;
      if (s.rvol > 0 && s.rvol < f.rvolMin) return false;
      if (s.gapPct < f.gapMin) return false;
      if (s.float && s.float > f.floatMax) return false;
      if (this.isEtfOrWarrant(s.ticker)) return false;
      return true;
    });
  }

  isEtfOrWarrant(ticker) {
    if (!ticker) return true;
    if (/[Ww][Ss]?$/.test(ticker)) return true;
    return ['SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK','ARKK','ARKG','SQQQ','TQQQ'].includes(ticker.toUpperCase());
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
    const text = newsItems.map(n => ((n.headline || '') + ' ' + (n.summary || '')).toLowerCase()).join(' ');
    if (/fda|approval|clearance|510\(k\)|breakthrough|pdufa|nda|bla/.test(text))
      return { type:'fda',      label:'FDA Approval',  class:'cat-fda',      score:9 };
    if (/earnings|revenue|eps|profit|quarterly|beat/.test(text))
      return { type:'earnings', label:'Earnings Beat', class:'cat-earnings', score:8 };
    if (/merger|acquisition|acquires|acquired|buyout|takeover/.test(text))
      return { type:'ma',       label:'M&A Deal',      class:'cat-ma',       score:8 };
    if (/contract|award|wins|selected|government/.test(text))
      return { type:'contract', label:'Contract Win',  class:'cat-contract', score:7 };
    if (/partnership|collaboration|agreement/.test(text))
      return { type:'partner',  label:'Partnership',   class:'cat-partner',  score:6 };
    if (/8-k|s-1|sec filing/.test(text))
      return { type:'sec',      label:'SEC Filing',    class:'cat-sec',      score:5 };
    return null;
  }

  generateDemoData() {
    console.log('[Scanner] WARNING: DEMO MODE — check DATA_SOURCE and POLYGON_API_KEY in Railway');
    let seed = 77777;
    const r = (min, max) => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return min + ((seed >>> 0) / 0xffffffff) * (max - min); };
    return [
      { ticker:'DEMO1', float:4e6 }, { ticker:'DEMO2', float:8e6 },
      { ticker:'DEMO3', float:12e6 }, { ticker:'DEMO4', float:6e6 }, { ticker:'DEMO5', float:20e6 },
    ].map(s => {
      const prev = r(1, 20), gap = r(5, 40), price = prev * (1 + gap / 100);
      return { ticker:s.ticker, name:s.ticker+' (Demo)', price:parseFloat(price.toFixed(2)), prevClose:parseFloat(prev.toFixed(2)), gapPct:parseFloat(gap.toFixed(2)), change:parseFloat(gap.toFixed(2)), volume:Math.floor(r(1e6,10e6)), rvol:parseFloat(r(3,15).toFixed(1)), pmHigh:parseFloat((price*r(1.01,1.1)).toFixed(2)), pmLow:parseFloat((prev*1.02).toFixed(2)), float:s.float, mktCap:null, news:[], catalyst:null };
    });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ScannerService };
