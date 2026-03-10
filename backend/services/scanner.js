/**
 * ScannerService — Pre-Market Fixed
 * Correctly reads Polygon snapshot fields during pre-market hours
 * Pre-market: price from lastTrade.p, gap from price vs prevDay.c
 * Regular hours: price from day fields, gap from day.o vs prevDay.c
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

  // ─── MARKET SESSION DETECTION ─────────────────
  getMarketSession() {
    const now  = new Date();
    const etMs = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et   = new Date(etMs);
    const h    = et.getHours();
    const m    = et.getMinutes();
    const mins = h * 60 + m;

    if (mins >= 240  && mins < 570)  return 'premarket';   // 4:00am - 9:30am
    if (mins >= 570  && mins < 960)  return 'regular';     // 9:30am - 4:00pm
    if (mins >= 960  && mins < 1200) return 'afterhours';  // 4:00pm - 8:00pm
    return 'closed';
  }

  async scan(filters = {}) {
    const f = {
      priceMin:  parseFloat(filters.priceMin  ?? process.env.PRICE_MIN  ?? '0.50'),
      priceMax:  parseFloat(filters.priceMax  ?? process.env.PRICE_MAX  ?? '25.00'),
      volMin:    parseInt(  filters.volMin    ?? process.env.VOL_MIN    ?? '0'),
      rvolMin:   parseFloat(filters.rvolMin   ?? process.env.RVOL_MIN   ?? '0'),
      gapMin:    parseFloat(filters.gapMin    ?? process.env.GAP_MIN    ?? '0'),
      floatMax:  parseInt(  filters.floatMax  ?? process.env.FLOAT_MAX  ?? '500000000'),
      catalyst:  filters.catalyst   === true || filters.catalyst   === 'true',
      excludeEtf:filters.excludeEtf !== false && filters.excludeEtf !== 'false',
    };

    const session = this.getMarketSession();
    console.log('[Scanner] Session:', session, '| Source:', this.source, '| Key set:', !!this.apiKey);
    console.log('[Scanner] Filters:', JSON.stringify(f));

    let stocks = [], usedDemo = false;

    try {
      if (this.source === 'polygon' && this.apiKey) {
        stocks = await this.fetchPolygonSnapshot(f, session);
      } else if (this.source === 'finnhub' && this.apiKey) {
        stocks = await this.fetchFinnhubGainers();
      } else {
        console.warn('[Scanner] No valid source — DATA_SOURCE=' + this.source + ' KEY=' + (this.apiKey ? 'SET' : 'MISSING'));
        stocks   = this.generateDemoData();
        usedDemo = true;
      }
    } catch (err) {
      console.error('[Scanner] Fetch error:', err.message);
      stocks   = this.generateDemoData();
      usedDemo = true;
    }

    console.log('[Scanner] Raw stocks after filtering:', stocks.length, '| demo:', usedDemo);

    // Enrich top 30 with news to avoid rate limits
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

  // ─── MAIN POLYGON FETCH ───────────────────────
  async fetchPolygonSnapshot(f, session) {
    const cached = this.cache.get('poly_snap_' + session);
    if (cached) {
      console.log('[Polygon] Cache hit:', cached.length, 'stocks for session:', session);
      return cached;
    }

    console.log('[Polygon] Fetching full snapshot for session:', session);

    let res;
    try {
      res = await axios.get(
        'https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers',
        {
          params:  { apiKey: this.apiKey, include_otc: false },
          timeout: 30000,
        }
      );
    } catch (err) {
      if (err.response) {
        console.error('[Polygon] HTTP', err.response.status, JSON.stringify(err.response.data));
        console.log('[Polygon] Falling back to gainers endpoint...');
        return await this.fetchPolygonGainers(f);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Snapshot returned:', tickers.length, 'raw tickers');

    if (!tickers.length) {
      console.warn('[Polygon] Empty snapshot — trying gainers fallback');
      return await this.fetchPolygonGainers(f);
    }

    const stocks = [];

    for (const t of tickers) {
      try {
        const stock = this.parseTicker(t, session, f);
        if (stock) stocks.push(stock);
      } catch (e) {
        // Skip malformed tickers silently
      }
    }

    // Sort by gap % descending
    stocks.sort((a, b) => b.gapPct - a.gapPct);

    const top = stocks.slice(0, 50);
    console.log('[Polygon] After filters:', stocks.length, '| Returning top:', top.length);

    // Cache for 20s during market hours, 60s pre/after hours
    const cacheTtl = session === 'regular' ? 20 : 60;
    this.cache.set('poly_snap_' + session, top, cacheTtl);
    return top;
  }

  // ─── TICKER PARSER ────────────────────────────
  // This is the critical function — reads the right fields
  // depending on whether market is open or in pre/after hours
  parseTicker(t, session, f) {
    const day  = t.day     || {};
    const prev = t.prevDay || {};
    const min  = t.min     || {};

    // ── PRICE ──
    // Pre/after market: lastTrade.p is the most recent trade price
    // Regular hours: day.c (current) or day.o (open) are populated
    const lastTradePrice = t.lastTrade?.p || 0;
    const lastQuoteAsk   = t.lastQuote?.P || 0;  // ask price
    const lastQuoteBid   = t.lastQuote?.p || 0;  // bid price
    const dayClose       = day.c || 0;
    const dayOpen        = day.o || 0;

    let price = 0;
    if (session === 'premarket' || session === 'afterhours') {
      // Pre/after hours: use last trade, fall back to mid-quote
      price = lastTradePrice
           || (lastQuoteAsk > 0 && lastQuoteBid > 0 ? (lastQuoteAsk + lastQuoteBid) / 2 : 0)
           || lastQuoteAsk
           || dayClose
           || dayOpen;
    } else {
      // Regular hours: day fields are populated
      price = dayClose || lastTradePrice || dayOpen || lastQuoteAsk;
    }

    if (!price || price <= 0) return null;

    // ── PRICE RANGE FILTER ──
    if (price < f.priceMin || price > f.priceMax) return null;

    // ── ETF/WARRANT FILTER ──
    if (f.excludeEtf && this.isEtfOrWarrant(t.ticker)) return null;

    // ── PREV CLOSE ──
    const prevClose = prev.c || 0;

    // ── GAP CALCULATION ──
    // Pre-market: compare current price to previous close
    // Regular hours: compare open price to previous close
    let gapPct = 0;
    if (prevClose > 0) {
      if (session === 'premarket') {
        gapPct = ((price - prevClose) / prevClose) * 100;
      } else if (session === 'regular' || session === 'afterhours') {
        const openPrice = dayOpen > 0 ? dayOpen : price;
        gapPct = ((openPrice - prevClose) / prevClose) * 100;
      }
    }

    // Only apply gap filter if we have valid prevClose data
    if (prevClose > 0 && f.gapMin > 0 && gapPct < f.gapMin) return null;

    // ── VOLUME ──
    // Pre-market: day.v starts accumulating from 4am, min.av is accumulated volume
    // Regular hours: day.v is the main volume field
    const volume = day.v || min.av || 0;

    // Only apply volume filter if we have data
    if (volume > 0 && f.volMin > 0 && volume < f.volMin) return null;

    // ── RELATIVE VOLUME ──
    const prevVol = prev.v || 0;
    let rvol = 0;
    if (prevVol > 0 && volume > 0) {
      rvol = volume / prevVol;
      if (f.rvolMin > 0 && rvol < f.rvolMin) return null;
    }

    // ── PRE-MARKET HIGH/LOW ──
    // During pre-market these are the session highs/lows
    // day.h and day.l accumulate from 4am
    const pmHigh = day.h > 0 ? day.h : price;
    const pmLow  = day.l > 0 ? day.l : price;

    return {
      ticker:    t.ticker,
      name:      t.ticker,
      price:     parseFloat(price.toFixed(2)),
      prevClose: parseFloat(prevClose.toFixed(2)),
      gapPct:    parseFloat(gapPct.toFixed(2)),
      change:    parseFloat((t.todaysChangePerc || (prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0)).toFixed(2)),
      volume:    Math.floor(volume),
      rvol:      parseFloat(rvol.toFixed(2)),
      pmHigh:    parseFloat(pmHigh.toFixed(2)),
      pmLow:     parseFloat(pmLow.toFixed(2)),
      float:     null,
      mktCap:    null,
      sector:    '',
      session:   session,
      news:      [],
      catalyst:  null,
    };
  }

  // ─── GAINERS FALLBACK ─────────────────────────
  async fetchPolygonGainers(f = {}) {
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

    const session = this.getMarketSession();
    const stocks  = tickers
      .map(t => {
        try { return this.parseTicker(t, session, f || {}); } catch(e) { return null; }
      })
      .filter(Boolean);

    this.cache.set('poly_gainers', stocks, 20);
    return stocks;
  }

  // ─── FINNHUB ──────────────────────────────────
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
      params: { symbol: ticker, token: process.env.FINNHUB_API_KEY || this.apiKey },
      timeout: 5000,
    });
    const q = res.data;
    if (!q?.c || q.c === 0) return null;
    const gapPct = q.pc > 0 ? ((q.o - q.pc) / q.pc) * 100 : 0;
    const result = {
      ticker, name: ticker,
      price:     q.c,
      prevClose: q.pc,
      gapPct:    parseFloat(gapPct.toFixed(2)),
      change:    q.pc > 0 ? parseFloat(((q.c - q.pc) / q.pc * 100).toFixed(2)) : 0,
      volume:    q.v || 0,
      rvol:      0,
      pmHigh:    q.h,
      pmLow:     q.l,
      float:     null, mktCap: null, news: [], catalyst: null,
    };
    this.cache.set('fhq_' + ticker, result, 15);
    return result;
  }

  // ─── HELPERS ──────────────────────────────────
  isEtfOrWarrant(ticker) {
    if (!ticker) return true;
    if (ticker.length > 5) return true;
    if (/W[Ss]?$/.test(ticker)) return true;
    const etfs = [
      'SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK',
      'ARKK','ARKG','ARKW','SQQQ','TQQQ','SPXL','SPXU','UVXY','VXX',
      'VIXY','LABD','LABU','SOXL','SOXS','FNGU','FNGD','CURE','NAIL',
      'UPRO','SPXS','TECL','TECS','UDOW','SDOW','TNA','TZA','FAS','FAZ',
    ];
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
    if (/8-k|s-1|sec filing|offering|raise|uplist/.test(text))
      return { type:'sec',      label:'SEC Filing',    class:'cat-sec',      score:5 };
    return null;
  }

  generateDemoData() {
    console.log('[Scanner] WARNING: DEMO MODE — check DATA_SOURCE and POLYGON_API_KEY in Railway');
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
        ticker:    s.ticker,
        name:      s.ticker + ' (Demo)',
        price:     parseFloat(price.toFixed(2)),
        prevClose: parseFloat(prev.toFixed(2)),
        gapPct:    parseFloat(gap.toFixed(2)),
        change:    parseFloat(gap.toFixed(2)),
        volume:    Math.floor(r(1e6, 10e6)),
        rvol:      parseFloat(r(3, 15).toFixed(1)),
        pmHigh:    parseFloat((price * r(1.01, 1.1)).toFixed(2)),
        pmLow:     parseFloat((prev * 1.02).toFixed(2)),
        float:     s.float,
        mktCap:    null,
        news:      [],
        catalyst:  null,
      };
    });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ScannerService };
