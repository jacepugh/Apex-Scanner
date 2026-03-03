/**
 * NewsService
 * Fetches news for tickers from multiple sources and classifies catalyst quality.
 * Sources: Polygon.io News, Finnhub News, Alpha Vantage News
 */

const axios = require('axios');

// Keywords that indicate LOW-QUALITY / generic news to filter out
const LOW_QUALITY_PATTERNS = [
  /market (wrap|recap|update|commentary)/i,
  /week(ly)? (market|stock) (review|outlook)/i,
  /top (stocks|movers) (to watch|today)/i,
  /analyst (raises|lowers|maintains) price target/i,
  /technical (analysis|indicator)/i,
  /options (volume|activity|flow)/i,
  /short (interest|seller)/i,
  /dividend (declared|increased|cut)/i,
  /stock split/i,
  /insider (buying|selling)/i,
];

// High-quality catalyst patterns with scores (1–10)
const CATALYST_PATTERNS = [
  { pattern: /fda (approv|clear|grant|designat)/i,         type:'fda',      label:'FDA Approval',     score:10, class:'cat-fda' },
  { pattern: /breakthrough (device|therapy|designation)/i, type:'fda',      label:'FDA Breakthrough',  score:9,  class:'cat-fda' },
  { pattern: /pdufa|nda (approv|accept)|bla (approv)/i,    type:'fda',      label:'FDA PDUFA/NDA',     score:9,  class:'cat-fda' },
  { pattern: /phase [123] (result|data|trial)/i,           type:'fda',      label:'Clinical Data',     score:8,  class:'cat-fda' },
  { pattern: /earnings (beat|surpass|exceed)/i,            type:'earnings', label:'Earnings Beat',     score:8,  class:'cat-earnings' },
  { pattern: /revenue (grew|increased|surged|beat)/i,      type:'earnings', label:'Revenue Beat',      score:7,  class:'cat-earnings' },
  { pattern: /merger|acqui(res?|sition)/i,                 type:'ma',       label:'M&A Deal',          score:9,  class:'cat-ma' },
  { pattern: /government contract|department of defense/i, type:'contract', label:'Gov Contract',      score:8,  class:'cat-contract' },
  { pattern: /(wins?|awarded|secures?) .{0,30}contract/i,  type:'contract', label:'Contract Win',      score:7,  class:'cat-contract' },
  { pattern: /strategic (partner|alliance|collaborat)/i,   type:'partner',  label:'Partnership',       score:6,  class:'cat-partner' },
  { pattern: /8-K|s-1 (filing|registration)/i,            type:'sec',      label:'SEC Filing',        score:5,  class:'cat-sec' },
];

class NewsService {
  constructor({ cache, apiKey }) {
    this.cache  = cache;
    this.apiKey = apiKey || process.env.POLYGON_API_KEY || process.env.FINNHUB_API_KEY || '';
    this.source = process.env.DATA_SOURCE || 'demo';
  }

  // ─── MAIN ENTRY POINT ──────────────────────────────────────
  async getNewsForTicker(ticker, daysBack = 10) {
    const cacheKey = `news_${ticker}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    let articles = [];

    try {
      switch (this.source) {
        case 'polygon':      articles = await this.fetchPolygonNews(ticker, daysBack); break;
        case 'finnhub':      articles = await this.fetchFinnhubNews(ticker, daysBack); break;
        case 'alphaVantage': articles = await this.fetchAVNews(ticker);                break;
        default:             articles = this.demoNews(ticker);                         break;
      }
    } catch (err) {
      console.warn(`[News] Failed for ${ticker}:`, err.message);
      articles = [];
    }

    // Filter out low-quality news
    const quality = articles.filter(a => !this.isLowQuality(a));

    // Score each article
    const scored = quality.map(a => ({
      ...a,
      catalyst: this.classifyArticle(a),
    })).filter(a => a.catalyst !== null); // keep only legitimate catalysts

    // Sort by catalyst score desc, then by date
    scored.sort((a, b) => {
      const scoreA = a.catalyst?.score || 0;
      const scoreB = b.catalyst?.score || 0;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return new Date(b.publishedAt) - new Date(a.publishedAt);
    });

    // Cache for 15 minutes (news doesn't change often)
    this.cache.set(cacheKey, scored, 900);
    return scored;
  }

  // ─── POLYGON NEWS ──────────────────────────────────────────
  async fetchPolygonNews(ticker, daysBack) {
    const from = new Date();
    from.setDate(from.getDate() - daysBack);
    const fromStr = from.toISOString().split('T')[0];

    const res = await axios.get('https://api.polygon.io/v2/reference/news', {
      params: {
        ticker,
        published_utc_gte: fromStr,
        order: 'desc',
        limit: 20,
        apiKey: this.apiKey,
      },
      timeout: 8000,
    });

    return (res.data?.results || []).map(a => ({
      headline:    a.title,
      summary:     a.description || '',
      source:      a.publisher?.name || 'Unknown',
      url:         a.article_url,
      publishedAt: a.published_utc,
      timeAgo:     this.timeAgo(a.published_utc),
    }));
  }

  // ─── FINNHUB NEWS ──────────────────────────────────────────
  async fetchFinnhubNews(ticker, daysBack) {
    const to   = new Date().toISOString().split('T')[0];
    const from = new Date();
    from.setDate(from.getDate() - daysBack);
    const fromStr = from.toISOString().split('T')[0];

    const res = await axios.get('https://finnhub.io/api/v1/company-news', {
      params: { symbol: ticker, from: fromStr, to, token: this.apiKey },
      timeout: 8000,
    });

    return (res.data || []).map(a => ({
      headline:    a.headline,
      summary:     a.summary || '',
      source:      a.source,
      url:         a.url,
      publishedAt: new Date(a.datetime * 1000).toISOString(),
      timeAgo:     this.timeAgo(new Date(a.datetime * 1000).toISOString()),
    }));
  }

  // ─── ALPHA VANTAGE NEWS ────────────────────────────────────
  async fetchAVNews(ticker) {
    const res = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function: 'NEWS_SENTIMENT',
        tickers: ticker,
        apikey: this.apiKey,
        limit: 20,
      },
      timeout: 10000,
    });

    const feed = res.data?.feed || [];
    return feed.map(a => ({
      headline:    a.title,
      summary:     a.summary || '',
      source:      a.source,
      url:         a.url,
      publishedAt: a.time_published,
      timeAgo:     this.timeAgo(a.time_published),
      sentiment:   a.overall_sentiment_label,
    }));
  }

  // ─── QUALITY FILTER ────────────────────────────────────────
  isLowQuality(article) {
    const text = `${article.headline} ${article.summary}`.toLowerCase();
    return LOW_QUALITY_PATTERNS.some(p => p.test(text));
  }

  // ─── CATALYST CLASSIFIER ───────────────────────────────────
  classifyArticle(article) {
    const text = `${article.headline} ${article.summary}`;
    for (const cp of CATALYST_PATTERNS) {
      if (cp.pattern.test(text)) {
        return { type: cp.type, label: cp.label, score: cp.score, class: cp.class };
      }
    }
    return null; // no recognizable catalyst
  }

  // ─── HELPERS ───────────────────────────────────────────────
  timeAgo(isoString) {
    const ms   = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(ms / 60000);
    const hrs  = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0)  return `${days}d ago`;
    if (hrs > 0)   return `${hrs}h ago`;
    if (mins > 0)  return `${mins}m ago`;
    return 'Just now';
  }

  demoNews(ticker) {
    const demos = {
      DEMO: [{
        headline:    'Company Reports Strong Quarterly Earnings Beat',
        summary:     'Quarterly revenue grew 42% year-over-year, exceeding analyst estimates.',
        source:      'PR Newswire',
        url:         '#',
        publishedAt: new Date().toISOString(),
        timeAgo:     '2h ago',
      }]
    };
    return demos[ticker] || demos.DEMO;
  }
}

module.exports = { NewsService };
