/**
 * ScannerService — Pre-Market Edition
 * - Float rotation % replaces RVOL as primary filter
 * - Dollar volume floor replaces share volume filter
 * - Gap tiering: normal (5-15%), strong (15-30%), explosive (30%+)
 * - RVOL kept in output for reference only
 * - Sorting: catalyst first, float rotation, then gap %
 */

const axios = require('axios');

const SORT_FN = (a, b) => {
  const catA = a.catalyst ? 1 : 0;
  const catB = b.catalyst ? 1 : 0;
  if (catB !== catA) return catB - catA;
  const rotA = a.floatRotation || 0;
  const rotB = b.floatRotation || 0;
  if (rotB !== rotA) return rotB - rotA;
  return b.gapPct - a.gapPct;
};

class ScannerService {
  constructor({ cache, news }) {
    this.cache       = cache;
    this.news        = news;
    this.source      = process.env.DATA_SOURCE || 'demo';
    this.apiKey      = process.env.POLYGON_API_KEY || '';
    this.prevResults = new Map();
  }

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

  async scan(filters = {}) {
    const f = {
      priceMin:     parseFloat(filters.priceMin     ?? process.env.PRICE_MIN      ?? '0.50'),
      priceMax:     parseFloat(filters.priceMax     ?? process.env.PRICE_MAX      ?? '25.00'),
      dollarVolMin: parseFloat(filters.dollarVolMin ?? process.env.DOLLAR_VOL_MIN ?? '0'),
      floatRotMin:  parseFloat(filters.floatRotMin  ?? process.env.FLOAT_ROT_MIN  ?? '0'),
      gapMin:       parseFloat(filters.gapMin       ?? process.env.GAP_MIN        ?? '0'),
      floatMax:     parseInt(  filters.floatMax     ?? process.env.FLOAT_MAX      ?? '50000000'),
      volMin:       parseInt(  filters.volMin       ?? process.env.VOL_MIN        ?? '0'),
      rvolMin:      parseFloat(filters.rvolMin      ?? process.env.RVOL_MIN       ?? '0'),
      catalyst:     filters.catalyst   === true || filters.catalyst   === 'true',
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
            const snap = await this.fetchPolygonSnapshot(f, session);
            const existing = new Set(stocks.map(s => s.ticker));
            snap.forEach(s => { if (!existing.has(s.ticker)) stocks.push(s); });
          }
        } else {
          stocks = await this.fetchPolygonSnapshot(f, session);
        }
      } else if (this.source === 'finnhub' && this.apiKey) {
        stocks = await this.fetchFinnhubGainers();
      } else {
        console.warn('[Scanner] No valid source — using demo data');
        stocks = this.generateDemoData();
        usedDemo = true;
      }
    } catch (err) {
      console.error('[Scanner] Fetch error:', err.message);
      stocks = this.generateDemoData();
      usedDemo = true;
    }

    console.log('[Scanner] Raw stocks after filtering:', stocks.length, '| demo:', usedDemo);

    const withAlerts = this.detectAlerts(stocks);
    this.cache.set('last_scan', withAlerts, 60);

    if (!usedDemo) {
      this.enrichNewsBackground(withAlerts);
      this.enrichFloatsBackground(withAlerts);
    }

    return withAlerts;
  }

  async enrichNewsBackground(stocks) {
    const toEnrich = stocks.slice(0, 20);
    for (const stock of toEnrich) {
      try {
        const newsItems = await this.news.getNewsForTicker(stock.ticker);
        stock.news      = newsItems;
        stock.catalyst  = this.classifyCatalyst(newsItems);
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
        stock.news = []; stock.catalyst = null;
      }
      // sleep removed — Polygon Starter has no rate limit
    }
    const cached = this.cache.get('last_scan');
    if (cached) { cached.sort(SORT_FN); this.cache.set('last_scan', cached, 60); }
    console.log('[Scanner] Background news enrichment complete');
  }

  async enrichFloatsBackground(stocks) {
    const needFloat = stocks.filter(s => !s.float);
    if (!needFloat.length) return;
    console.log('[Scanner] Float enrichment: fetching', needFloat.length, 'tickers');

    await Promise.all(needFloat.map(async (stock) => {
      try {
        const cacheKey = 'float_' + stock.ticker;
        const cached   = this.cache.get(cacheKey);
        if (cached !== undefined) {
          stock.float = cached;
        } else {
          const res = await axios.get(
            `https://api.polygon.io/v3/reference/tickers/${stock.ticker}`,
            { params: { apiKey: this.apiKey }, timeout: 8000 }
          );
          const details = res.data?.results || {};
          const float   = details.share_class_shares_outstanding
                       || details.weighted_shares_outstanding
                       || null;
          this.cache.set(cacheKey, float, 86400);
          stock.float = float;
        }
        if (stock.float && stock.float > 0 && stock.volume > 0) {
          stock.floatRotation = parseFloat(((stock.volume / stock.float) * 100).toFixed(2));
        }
      } catch(e) { /* leave null */ }
    }));

    const cached = this.cache.get('last_scan');
    if (cached) { cached.sort(SORT_FN); this.cache.set('last_scan', cached, 60); }
    console.log('[Scanner] Float enrichment complete');
  }

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
      try { const s = this.parseTicker(t, session, f); if (s) stocks.push(s); } catch(e) {}
    }

    stocks.sort(SORT_FN);
    const top = stocks.slice(0, 50);
    console.log('[Polygon] After filters:', stocks.length, '| Returning top:', top.length);
    this.cache.set(cacheKey, top, session === 'regular' ? 20 : 60);
    return top;
  }

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
      if (err.response) throw new Error('Polygon gainers ' + err.response.status);
      throw err;
    }

    const tickers = res.data?.tickers || [];
    console.log('[Polygon] Gainers returned:', tickers.length, 'raw tickers');

    const stocks = tickers
      .map(t => { try { return this.parseTicker(t, session, f); } catch(e) { return null; } })
      .filter(Boolean);

    stocks.sort(SORT_FN);
    console.log('[Polygon] Gainers after parse:', stocks.length, '| top:', stocks[0]?.ticker, stocks[0]?.gapPct + '%');

    this.cache.set(cacheKey, stocks, session === 'premarket' ? 30 : 20);
    return stocks;
  }

  getGapTier(gapPct) {
    if (gapPct >= 30) return 3;
    if (gapPct >= 15) return 2;
    if (gapPct >= 5)  return 1;
    return 0;
  }

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
    const topChangePerc  = t.todaysChangePerc || 0;
    const topChange      = t.todaysChange || 0;

    let price = 0;
    if (session === 'premarket' || session === 'afterhours') {
      price = lastTradePrice
           || (lastQuoteAsk > 0 && lastQuoteBid > 0 ? (lastQuoteAsk + lastQuoteBid) / 2 : 0)
           || lastQuoteAsk || dayClose || dayOpen || prevDayClose;
    } else {
      price = dayClose || lastTradePrice || dayOpen || lastQuoteAsk || prevDayClose;
    }

    if ((!price || price <= 0) && prevDayClose > 0 && topChange !== 0) {
      price = prevDayClose + topChange;
    }

    if (!price || price <= 0) return null;
    if (price < f.priceMin || price > f.priceMax) return null;
    if (f.excludeEtf && this.isEtfOrWarrant(t.ticker)) return null;

    const prevClose    = prevDayClose;
    const volume       = day.v || min.av || 0;
    const prevVol      = prev.v || 0;
    const dollarVolume = price * volume;

    if (f.dollarVolMin > 0 && dollarVolume < f.dollarVolMin) return null;

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
    if (gapPct > 500)  return null;
    if (gapPct < -80)  return null;
    if (dollarVolume < 10000 && volume > 0) return null;

    const sharesOutstanding = t.shareClassSharesOutstanding || t.weightedSharesOutstanding || null;
    const float             = sharesOutstanding || null;
    const floatRotation     = (float && float > 0 && volume > 0)
      ? parseFloat(((volume / float) * 100).toFixed(2)) : null;

    if (f.floatRotMin > 0 && floatRotation !== null && floatRotation < f.floatRotMin) return null;
    if (float && float > f.floatMax) return null;

    let rvol = 0;
    if (prevVol > 0 && volume > 0) rvol = parseFloat((volume / prevVol).toFixed(2));

    return {
      ticker:        t.ticker,
      name:          t.ticker,
      price:         parseFloat(price.toFixed(2)),
      prevClose:     parseFloat(prevClose.toFixed(2)),
      gapPct:        parseFloat(gapPct.toFixed(2)),
      gapTier:       this.getGapTier(gapPct),
      change:        parseFloat((prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0).toFixed(2)),
      volume:        Math.floor(volume),
      dollarVolume:  Math.floor(dollarVolume),
      rvol,
      floatRotation,
      pmHigh:        parseFloat((day.h > 0 ? day.h : price).toFixed(2)),
      pmLow:         parseFloat((day.l > 0 ? day.l : price).toFixed(2)),
      float,
      mktCap:        null,
      sector:        '',
      session,
      news:          [],
      catalyst:      null,
    };
  }

  isEtfOrWarrant(ticker) {
    if (!ticker) return true;
    if (ticker.length > 5) return true;
    if (/W[Ss]?$/.test(ticker)) return true;
    if (/R$/.test(ticker) && ticker.length === 5) return true;
    if (/U$/.test(ticker) && ticker.length === 5) return true;
    const etfs = new Set([
      'SPY','QQQ','IWM','GLD','SLV','TLT','HYG','XLE','XLF','XLK',
      'ARKK','ARKG','ARKW','SQQQ','TQQQ','SPXL','SPXU','UVXY','VXX',
      'VIXY','LABD','LABU','SOXL','SOXS','FNGU','FNGD','CURE','NAIL',
      'UPRO','SPXS','TECL','TECS','UDOW','SDOW','TNA','TZA','FAS','FAZ',
      'BOIL','KOLD','GUSH','DRIP','DUST','JNUG','NUGT','JDST','DGAZ',
      'UGAZ','UCO','SCO','BITI','BITO','MSTU','MSTX','NVDL','TSLL',
      'ACTS','DFAC','DFAS','DFAU','DFAX','AVUV','AVLV','AVDV',
    ]);
    return etfs.has(ticker.toUpperCase());
  }

  detectAlerts(stocks) {
    return stocks.map(s => {
      const prev        = this.prevResults.get(s.ticker);
      const breakingPmh = prev && !prev.breakingPmh && s.price >= s.pmHigh;
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
    console.log('[Scanner] WARNING: DEMO MODE');
    let seed = 77777;
    const r = (min, max) => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return min + ((seed >>> 0) / 0xffffffff) * (max - min);
    };
    return [
      { ticker:'DEMO1', float:4e6,  floatRotPct:28 },
      { ticker:'DEMO2', float:8e6,  floatRotPct:12 },
      { ticker:'DEMO3', float:12e6, floatRotPct:6  },
      { ticker:'DEMO4', float:6e6,  floatRotPct:35 },
      { ticker:'DEMO5', float:20e6, floatRotPct:4  },
    ].map(s => {
      const prev=r(1,20), gap=r(5,45), price=prev*(1+gap/100);
      const volume=Math.floor(s.float*(s.floatRotPct/100));
      const gapPct=parseFloat(gap.toFixed(2));
      return {
        ticker:s.ticker, name:s.ticker+' (Demo)',
        price:parseFloat(price.toFixed(2)), prevClose:parseFloat(prev.toFixed(2)),
        gapPct, gapTier:this.getGapTier(gapPct), change:gapPct, volume,
        dollarVolume:Math.floor(price*volume), rvol:parseFloat(r(1,5).toFixed(1)),
        floatRotation:s.floatRotPct,
        pmHigh:parseFloat((price*r(1.01,1.1)).toFixed(2)),
        pmLow:parseFloat((prev*1.02).toFixed(2)),
        float:s.float, mktCap:null, news:[], catalyst:null,
      };
    });
  }

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
      ticker, name: ticker, price: q.c, prevClose: q.pc,
      gapPct: parseFloat(gapPct.toFixed(2)), gapTier: this.getGapTier(gapPct),
      change: q.pc > 0 ? parseFloat(((q.c-q.pc)/q.pc*100).toFixed(2)) : 0,
      volume: q.v||0, dollarVolume: q.c*(q.v||0), rvol:0, floatRotation:null,
      pmHigh:q.h, pmLow:q.l, float:null, mktCap:null, news:[], catalyst:null,
    };
    this.cache.set('fhq_' + ticker, result, 15);
    return result;
  }
}

module.exports = { ScannerService };
