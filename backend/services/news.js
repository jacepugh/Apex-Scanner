/**
 * NewsService — v3
 * - No hard age cutoff — return all articles found
 * - Age filtering handled client-side via news window slider
 * - Polygon → Finnhub → AlphaVantage fallback chain
 * - Catalyst classification per article
 */

const axios = require('axios');

const LOW_QUALITY_PATTERNS = [
  /market (wrap|recap|update|commentary)/i,
  /week(ly)? (market|stock) (review|outlook)/i,
  /top (stocks|movers) (to watch|today)/i,
  /technical (analysis|indicator)/i,
  /options (volume|activity|flow)/i,
];

const CATALYST_PATTERNS = [
  { pattern: /fda (approv|clear|grant|designat)/i,         type:'fda',      label:'FDA Approval',    score:10, class:'cat-fda' },
  { pattern: /breakthrough (device|therapy|designation)/i, type:'fda',      label:'FDA Breakthrough', score:9,  class:'cat-fda' },
  { pattern: /pdufa|nda (approv|accept)|bla (approv)/i,    type:'fda',      label:'FDA PDUFA/NDA',    score:9,  class:'cat-fda' },
  { pattern: /phase [123] (result|data|trial)/i,           type:'fda',      label:'Clinical Data',    score:8,  class:'cat-fda' },
  { pattern: /earnings (beat|surpass|exceed)/i,            type:'earnings', label:'Earnings Beat',    score:8,  class:'cat-earnings' },
  { pattern: /revenue (grew|increased|surged|beat)/i,      type:'earnings', label:'Revenue Beat',     score:7,  class:'cat-earnings' },
  { pattern: /quarterly (result|earning|revenue)/i,        type:'earnings', label:'Earnings Report',  score:7,  class:'cat-earnings' },
  { pattern: /merger|acqui(res?|sition)/i,                 type:'ma',       label:'M&A Deal',         score:9,  class:'cat-ma' },
  { pattern: /government contract|department of defense/i, type:'contract', label:'Gov Contract',     score:8,  class:'cat-contract' },
  { pattern: /(wins?|awarded|secures?) .{0,30}contract/i,  type:'contract', label:'Contract Win',     score:7,  class:'cat-contract' },
  { pattern: /strategic (partner|alliance|collaborat)/i,   type:'partner',  label:'Partnership',      score:6,  class:'cat-partner' },
  { pattern: /agreement|joint venture|memorandum/i,        type:'partner',  label:'Partnership',      score:5,  class:'cat-partner' },
  { pattern: /8-K|s-1 (filing|registration)/i,            type:'sec',      label:'SEC Filing',       score:5,  class:'cat-sec' },
  { pattern: /raises? \$|offering|public offering|ipo/i,   type:'sec',      label:'Capital Raise',    score:5,  class:'cat-sec' },
  { pattern: /uplist|nasdaq|nyse listing/i,                type:'sec',      label:'Exchange Listing', score:6,  class:'cat-sec' },
];

class NewsService {
  constructor({ cache, apiKey }) {
    this.cache           = cache;
    this.polygonKey      = process.env.POLYGON_API_KEY      || apiKey || '';
    this.finnhubKey      = process.env.FINNHUB_API_KEY      || '';
    this.alphaVantageKey = process.env.ALPHA_VANTAGE_API_KEY || '';
    this.source          = process.env.DATA_SOURCE          || 'demo';
  }

  // ─── MAIN ENTRY POINT ─────────────────────────
  // Returns ALL articles found — no age filtering here
  // Age/catalyst filtering is done client-side via news window slider
  async getNewsForTicker(ticker) {
    const cacheKey = 'news_v3_' + ticker;
    const cached   = this.cache.get(cacheKey);
    if (cached) return cached;

    let articles = [];

    try {
      // Try Polygon first — fetch last 7 days to cast a wide net
      if (this.polygonKey) {
        articles = await this.fetchPolygonNews(ticker, 7);
      }
      // Finnhub fallback
      if (!articles.length && this.finnhubKey) {
        articles = await this.fetchFinnhubNews(ticker, 7);
      }
      // Alpha Vantage last resort
      if (!articles.length && this.alphaVantageKey) {
        articles = await this.fetchAVNews(ticker);
      }
    } catch (err) {
      console.warn('[News] Failed for ' + ticker + ':', err.message);
      articles = [];
    }

    console.log(`[News] ${ticker}: ${articles.length} raw articles`);

    // Remove low-quality filler
    const quality = articles.filter(a => !this.isLowQuality(a));

    // Classify each article
    const classified = quality.map(a => ({
      ...a,
      catalyst: this.classifyArticle(a),
    }));

    // Sort: catalyst articles first, then by recency
    classified.sort((a, b) => {
      const scoreA = a.catalyst?.score || 0;
      const scoreB = b.catalyst?.score || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });

    // Return top 5 — no age filter applied here
    const final = classified.slice(0, 5);

    // Cache 10 minutes
    this.cache.set(cacheKey, final, 600);
    return final;
  }

  // ─── POLYGON NEWS ─────────────────────────────
  async fetchPolygonNews(ticker, daysBack) {
    const from = new Date();
    from.setDate(from.getDate() - daysBack);
    const fromStr = from.toISOString().split('T')[0];

    let res;
    try {
      res = await axios.get('https://api.polygon.io/v2/reference/news', {
        params: {
          ticker,
          published_utc_gte: fromStr,
          order: 'desc',
          limit: 10,
          apiKey: this.polygonKey,
        },
        timeout: 8000,
      });
    } catch (err) {
      console.warn('[News/Polygon] ' + ticker + ':', err.response?.status || err.message);
      return [];
    }

    const results = res.data?.results || [];
    console.log('[News/Polygon] ' + ticker + ': ' + results.length + ' articles');

    return results.map(a => ({
      headline:    a.title             || '',
      summary:     a.description       || '',
      source:      a.publisher?.name   || 'Polygon News',
      url:         a.article_url       || '',
      publishedAt: a.published_utc     || new Date().toISOString(),
      timeAgo:     this.timeAgo(a.published_utc),
    }));
  }

  // ─── FINNHUB NEWS ─────────────────────────────
  async fetchFinnhubNews(ticker, daysBack) {
    const to      = new Date().toISOString().split('T')[0];
    const from    = new Date();
    from.setDate(from.getDate() - daysBack);
    const fromStr = from.toISOString().split('T')[0];

    let res;
    try {
      res = await axios.get('https://finnhub.io/api/v1/company-news', {
        params: { symbol: ticker, from: fromStr, to, token: this.finnhubKey },
        timeout: 8000,
      });
    } catch (err) {
      console.warn('[News/Finnhub] ' + ticker + ':', err.response?.status || err.message);
      return [];
    }

    const results = res.data || [];
    console.log('[News/Finnhub] ' + ticker + ': ' + results.length + ' articles');

    return results.map(a => ({
      headline:    a.headline || '',
      summary:     a.summary  || '',
      source:      a.source   || 'Finnhub',
      url:         a.url      || '',
      publishedAt: new Date(a.datetime * 1000).toISOString(),
      timeAgo:     this.timeAgo(new Date(a.datetime * 1000).toISOString()),
    }));
  }

  // ─── ALPHA VANTAGE NEWS ───────────────────────
  async fetchAVNews(ticker) {
    let res;
    try {
      res = await axios.get('https://www.alphavantage.co/query', {
        params: {
          function: 'NEWS_SENTIMENT',
          tickers:  ticker,
          apikey:   this.alphaVantageKey,
          limit:    10,
        },
        timeout: 10000,
      });
    } catch (err) {
      console.warn('[News/AV] ' + ticker + ':', err.message);
      return [];
    }

    return (res.data?.feed || []).map(a => ({
      headline:    a.title   || '',
      summary:     a.summary || '',
      source:      a.source  || 'Alpha Vantage',
      url:         a.url     || '',
      publishedAt: this.parseAVDate(a.time_published),
      timeAgo:     this.timeAgo(this.parseAVDate(a.time_published)),
    }));
  }

  // ─── HELPERS ──────────────────────────────────
  isLowQuality(article) {
    const text = ((article.headline || '') + ' ' + (article.summary || '')).toLowerCase();
    return LOW_QUALITY_PATTERNS.some(p => p.test(text));
  }

  classifyArticle(article) {
    const text = (article.headline || '') + ' ' + (article.summary || '');
    for (const cp of CATALYST_PATTERNS) {
      if (cp.pattern.test(text)) {
        return { type: cp.type, label: cp.label, score: cp.score, class: cp.class };
      }
    }
    return null;
  }

  // Alpha Vantage date format: 20240115T143000
  parseAVDate(str) {
    if (!str) return new Date().toISOString();
    if (/^\d{8}T\d{6}$/.test(str)) {
      return str.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
        '$1-$2-$3T$4:$5:$6Z'
      );
    }
    return str;
  }

  timeAgo(isoString) {
    if (!isoString) return '';
    const ms   = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(ms / 60000);
    const hrs  = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0)  return days + 'd ago';
    if (hrs  > 0)  return hrs  + 'h ago';
    if (mins > 0)  return mins + 'm ago';
    return 'Just now';
  }
}

module.exports = { NewsService };
