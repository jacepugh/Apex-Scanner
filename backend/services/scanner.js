/**
 * ScannerService — Pre-Market Edition
 * - Float rotation % replaces RVOL as primary filter
 * - Dollar volume floor replaces share volume filter
 * - Gap tiering: normal (5-15%), strong (15-30%), explosive (30%+)
 * - RVOL kept in output for reference only
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

  // ─── MARKET SESSION ───────────────────────────
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

  // ─── MAIN SCAN ────────────────────────────────
  async scan(filters = {}) {
    const f = {
      priceMin:        parseFloat(filters.priceMin        ?? process.env.PRICE_MIN        ?? '0.50'),
      priceMax:        parseFloat(filters.priceMax        ?? process.env.PRICE_MAX        ?? '25.00'),
      // Dollar volume floor — replaces raw share volume as primary filter
      dollarVolMin:    parseFloat(filters.dollarVolMin    ?? process.env.DOLLAR_VOL_MIN   ?? '0'),
      // Float rotation % — replaces RVOL as primary pre-market filter
      floatRotMin:     parseFloat(filters.floatRotMin     ?? process.env.FLOAT_ROT_MIN    ?? '0'),
      gapMin:          parseFloat(filters.gapMin          ?? process.env.GAP_MIN          ?? '0'),
      floatMax:        parseInt(  filters.floatMax        ?? process.env.FLOAT_MAX        ?? '50000000'),
      // Legacy — kept for backwards compat, used as soft reference only
      volMin:          parseInt(  filters.volMin          ?? process.env.VOL_MIN          ?? '0'),
      rvolMin:         parseFloat(filters.rvolMin         ?? process.env.RVOL_MIN         ?? '0'),
      catalyst:        filters.catalyst    === true || filters.catalyst    === 'true',
      excludeEtf:      filters.excludeEtf !== false && filters.excludeEtf !== 'false',
    };

    const session = this.getMarketSession();
    console.log('[Scanner] Session:', session, '| Source:', this.source, '| Key:', !!this.apiKey);
    console.log('[Scanner] Filters:', JSON.stringify(f));

    let stocks = [], usedDemo = false;

    try {
      if (this.source === 'polygon' && this.apiKey) {
        stocks = await this.fetchPolygonSnapshot(f, session);
      } else if (this.source === 'finnhub' && this.apiKey) {
        stocks = await this.fetchFinnhubGainers();
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

    if (!usedDemo) this.enrichNewsBackground(withAlerts);

    return withAlerts;
  }

  // ─── BACKGROUND NEWS ENRICHMENT ───────────────
  async enrichNewsBackground(stocks) {
    const toEnrich = stocks.slice(0, 20);
    for (const stock of toEnrich) {
      try {
        const newsItems    = await this.news.getNewsForTicker(stock.ticker);
        stock.news         = newsItems;
        stock.catalyst     = this.classifyCatalyst(newsItems);
        const cached = this.cache.get('last_scan');
        if (cached) {
          const idx = cached.findIndex(s => s.ticker === stock.ticker);
          if (idx !== -1) {
            cached[idx].news     = stock.news;
            cached[idx].catalyst = stock.catalyst;
            this.cache.set('last_scan', cached, 60);
          }
        }
      } catch (e) {
        stock.news     = [];
        stock.catalyst = null;
      }
      await this.sleep(200);
    }
    console.log('[Scanner] Background news enrichment complete');
  }

  // ─── POLYGON FULL SNAPSHOT ────────────────────
  async fetchPolygonSnapshot(f, session) {
    const cacheKey = 'poly_snap_' + session;
    const cached   = this.cache.get(cacheKey);
    if (cached) {
      console.log('[Polygon] Cache hit:', cached.length, 'stocks');
      return cached;
    }

    console.log('[Polygon] Fetching full snapshot for session:', session);

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
        return await this.fetchPolygonGainers(f, session);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Snapshot returned:', tickers.length, 'raw tickers');

    if (!tickers.length) {
      console.warn('[Polygon] Empty snapshot — trying gainers fallback');
      return await this.fetchPolygonGainers(f, session);
    }

    const stocks = [];
    for (const t of tickers) {
      try {
        const stock = this.parseTicker(t, session, f);
        if (stock) stocks.push(stock);
      } catch (e) {
        // skip malformed tickers
      }
    }

    // Sort: catalyst first, then float rotation, then gap %
    stocks.sort((a, b) => {
      const catA = a.catalyst ? 1 : 0;
      const catB = b.catalyst ? 1 : 0;
      if (catB !== catA) return catB - catA;
      const rotA = a.floatRotation || 0;
      const rotB = b.floatRotation || 0;
      if (rotB !== rotA) return rotB - rotA;
      return b.gapPct - a.gapPct;
    });

    const top = stocks.slice(0, 50);
    console.log('[Polygon] After filters:', stocks.length, '| Returning top:', top.length);

    const cacheTtl = session === 'regular' ? 20 : 60;
    this.cache.set(cacheKey, top, cacheTtl);
    return top;
  }

  // ─── GAP TIER ─────────────────────────────────
  // 1 = normal (5-15%), 2 = strong (15-30%), 3 = explosive (30%+)
  getGapTier(gapPct) {
    if (gapPct >= 30) return 3;
    if (gapPct >= 15) return 2;
    if (gapPct >= 5)  return 1;
    return 0;
  }

  // ─── TICKER PARSER ────────────────────────────
  parseTicker(t, session, f) {
    if (!t.ticker) return null;

    const day  = t.day     || {};
    const prev = t.prevDay || {};
    const min  = t.min     || {};

    const lastTradePrice = t.lastTrade?.p || 0;
    const lastQuoteAsk   = t.lastQuote?.P || 0;
    const lastQuoteBid   = t.lastQuote?.p || 0;
    const dayClose       = day.c || 0;
    const dayOpen        = day.o || 0;
    const prevDayClose   = prev.c || 0;

    // Gainers endpoint puts current price in todaysChange fields at top level
    // Use these to reconstruct price when nested day fields are empty
    const topChangePerc  = t.todaysChangePerc || 0;
    const topChange      = t.todaysChange || 0;

    // Price by session — prevDayClose is final fallback so tickers are never
    // dropped purely because they haven't printed a trade yet
    let price = 0;
    if (session === 'premarket' || session === 'afterhours') {
      price = lastTradePrice
           || (lastQuoteAsk > 0 && lastQuoteBid > 0 ? (lastQuoteAsk + lastQuoteBid) / 2 : 0)
           || lastQuoteAsk
           || dayClose
           || dayOpen
           || prevDayClose;
    } else {
      price = dayClose || lastTradePrice || dayOpen || lastQuoteAsk || prevDayClose;
    }

    // If we still have no price but have change data, reconstruct from prevDay + change
    if ((!price || price <= 0) && prevDayClose > 0 && topChange !== 0) {
      price = prevDayClose + topChange;
    }

    if (!price || price <= 0) return null;
    if (price < f.priceMin || price > f.priceMax) return null;
    if (f.excludeEtf && this.isEtfOrWarrant(t.ticker)) return null;

    const prevClose = prevDayClose;
    const volume    = day.v || min.av || 0;
    const prevVol   = prev.v || 0;

    // ── Dollar volume — primary activity filter ──
    const dollarVolume = price * volume;
    if (f.dollarVolMin > 0 && dollarVolume < f.dollarVolMin) return null;

    // ── Gap calculation ──
    // Use Polygon's pre-calculated todaysChangePerc when available (gainers endpoint)
    // Fall back to manual calc from price vs prevClose
    let gapPct = 0;
    if (topChangePerc !== 0) {
      gapPct = topChangePerc;
    } else if (prevClose > 0) {
      if (session === 'premarket' || session === 'afterhours') {
        gapPct = ((price - prevClose) / prevClose) * 100;
      } else {
        const openPrice = dayOpen > 0 ? dayOpen : price;
        gapPct = ((openPrice - prevClose) / prevClose) * 100;
      }
    }

    if (prevClose > 0 && f.gapMin > 0 && gapPct < f.gapMin) return null;

    // ── Float rotation % — primary pre-market signal ──
    // Polygon snapshot doesn't include float directly — we use shares outstanding
    // from the ticker details if available, otherwise null
    // Float rotation = volume / float * 100
    // We calculate it here if float is available; otherwise frontend shows N/A
    const sharesOutstanding = t.shareClassSharesOutstanding || t.weightedSharesOutstanding || null;
    const float             = sharesOutstanding || null;
    const floatRotation     = (float && float > 0 && volume > 0)
      ? parseFloat(((volume / float) * 100).toFixed(2))
      : null;

    // Filter by float rotation if we have it and filter is set
    if (f.floatRotMin > 0 && floatRotation !== null && floatRotation < f.floatRotMin) return null;

    // Float size filter
    if (float && float > f.floatMax) return null;

    // ── RVOL — kept as reference, not primary filter ──
    let rvol = 0;
    if (prevVol > 0 && volume > 0) {
      rvol = parseFloat((volume / prevVol).toFixed(2));
    }

    // ── Gap tier ──
    const gapTier = this.getGapTier(gapPct);

    const pmHigh = day.h > 0 ? day.h : price;
    const pmLow  = day.l > 0 ? day.l : price;

    return {
      ticker:        t.ticker,
      name:          t.ticker,
      price:         parseFloat(price.toFixed(2)),
      prevClose:     parseFloat(prevClose.toFixed(2)),
      gapPct:        parseFloat(gapPct.toFixed(2)),
      gapTier,                                          // 0-3
      change:        parseFloat((prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0).toFixed(2)),
      volume:        Math.floor(volume),
      dollarVolume:  Math.floor(dollarVolume),          // new
      rvol:          rvol,                              // kept, not primary
      floatRotation: floatRotation,                     // new — null if float unavailable
      pmHigh:        parseFloat(pmHigh.toFixed(2)),
      pmLow:         parseFloat(pmLow.toFixed(2)),
      float:         float,
      mktCap:        null,
      sector:        '',
      session:       session,
      news:          [],
      catalyst:      null,
    };
  }

  // ─── GAINERS FALLBACK ─────────────────────────
  async fetchPolygonGainers(f = {}, session = 'regular') {
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
        console.error('[Polygon] Gainers HTTP', err.response.status);
        throw new Error('Polygon gainers ' + err.response.status);
      }
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Gainers returned:', tickers.length);

    const stocks = tickers
      .map(t => { try { return this.parseTicker(t, session, f); } catch(e) { return null; } })
      .filter(Boolean);

    // Sort: catalyst first, then float rotation, then gap %
    stocks.sort((a, b) => {
      const catA = a.catalyst ? 1 : 0;
      const catB = b.catalyst ? 1 : 0;
      if (catB !== catA) return catB - catA;
      const rotA = a.floatRotation || 0;
      const rotB = b.floatRotation || 0;
      if (rotB !== rotA) return rotB - rotA;
      return b.gapPct - a.gapPct;
    });

    console.log('[Polygon] Gainers after parse:', stocks.length, '| top gap:', stocks[0]?.ticker, stocks[0]?.gapPct + '%');

    const ttl = session === 'premarket' ? 30 : 20;
    this.cache.set('poly_gainers_' + session, stocks, ttl);
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
      price: q.c, prevClose: q.pc,
      gapPct: parseFloat(gapPct.toFixed(2)),
      gapTier: this.getGapTier(gapPct),
      change: q.pc > 0 ? parseFloat(((q.c - q.pc) / q.pc * 100).toFixed(2)) : 0,
      volume: q.v || 0,
      dollarVolume: q.c * (q.v || 0),
      rvol: 0,
      floatRotation: null,
      pmHigh: q.h, pmLow: q.l,
      float: null, mktCap: null, news: [], catalyst: null,
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
      // Volume spike now based on dollar volume doubling
      const volumeSpike = prev && s.dollarVolume > 0 && prev.dollarVolume > 0
        && s.dollarVolume >= prev.dollarVolume * 2;
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
      { ticker:'DEMO1', float:4e6,  floatRotPct: 28 },
      { ticker:'DEMO2', float:8e6,  floatRotPct: 12 },
      { ticker:'DEMO3', float:12e6, floatRotPct: 6  },
      { ticker:'DEMO4', float:6e6,  floatRotPct: 35 },
      { ticker:'DEMO5', float:20e6, floatRotPct: 4  },
    ].map(s => {
      const prev    = r(1, 20);
      const gap     = r(5, 45);
      const price   = prev * (1 + gap / 100);
      const volume  = Math.floor(s.float * (s.floatRotPct / 100));
      const gapPct  = parseFloat(gap.toFixed(2));
      return {
        ticker: s.ticker, name: s.ticker + ' (Demo)',
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
        mktCap:        null, news: [], catalyst: null,
      };
    });
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { ScannerService };
