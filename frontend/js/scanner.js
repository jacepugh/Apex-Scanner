/* ── scanner.js — filter bar, card rendering, chart, A-setup scoring ── */



// ── FILTER BAR ───────────────────────────────────────────
function initFilterBar() {
  ['gap', 'float', 'price', 'vol'].forEach(updateSliderDisplay);
  applyDrawerFilters();
}

function toggleFilterBar() {
  const bar  = document.getElementById('filter-bar');
  const page = document.getElementById('page-scanner');
  const open = bar.classList.toggle('expanded');
  page.classList.toggle('filters-expanded', open);
}

function updateSliderDisplay(type) {
  const map = {
    gap:   { el: 'f-gap',   disp: 'fv-gap',   fn: v => v + '%' },
    float: { el: 'f-float', disp: 'fv-float',  fn: v => fmt(parseInt(v)) },
    price: { el: 'f-price', disp: 'fv-price',  fn: v => '$' + parseFloat(v).toFixed(0) },
    vol:   { el: 'f-vol',   disp: 'fv-vol',    fn: v => { const n = parseInt(v); return n >= 1e6 ? '$' + (n/1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'K' : '$0'; } },
  };
  const m = map[type];
  if (!m) return;
  const el = document.getElementById(m.el);
  const disp = document.getElementById(m.disp);
  if (el && disp) disp.textContent = m.fn(el.value);
}

function applyDrawerFilters() {
  STATE.filters.gapMin       = parseFloat(document.getElementById('f-gap').value)   || 0;
  STATE.filters.floatMax     = parseInt(document.getElementById('f-float').value)    || 20_000_000;
  STATE.filters.priceMax     = parseFloat(document.getElementById('f-price').value)  || 5;
  STATE.filters.dollarVolMin = parseInt(document.getElementById('f-vol').value)      || 0;
  applyFilters();
}

function relaxFilters() {
  STATE.filters.gapMin       = 0;
  STATE.filters.floatMax     = 50_000_000;
  STATE.filters.priceMax     = 5;
  STATE.filters.dollarVolMin = 0;
  document.getElementById('f-gap').value   = 0;
  document.getElementById('f-float').value = 50_000_000;
  document.getElementById('f-price').value = 5;
  document.getElementById('f-vol').value   = 0;
  ['gap', 'float', 'price', 'vol'].forEach(updateSliderDisplay);
  applyFilters();
}

// ── FILTER + RENDER ─────────────────────────────────────
function applyFilters() {
  const f = STATE.filters;
  let stocks = STATE.stocks.filter(s => {
    if (s.price < f.priceMin || s.price > f.priceMax) return false;
    if (s.prevClose > 0 && s.gapPct < f.gapMin) return false;
    if (s.floatShares > 0 && s.floatShares > f.floatMax) return false;
    if (f.dollarVolMin > 0 && (s.dollarVolume || 0) < f.dollarVolMin) return false;
    if (f.catalyst && !s.catalyst) return false;
    return true;
  });

  // Sort: A-setups first, then by gap desc, cap at 20
  stocks.sort((a, b) => {
    const as = scoreASetup(a) > 0 ? 1 : 0;
    const bs = scoreASetup(b) > 0 ? 1 : 0;
    if (bs !== as) return bs - as;
    return (b.gapPct || 0) - (a.gapPct || 0);
  });
  stocks = stocks.slice(0, 20);

  renderCards(stocks);
}

function renderCards(stocks) {
  const list   = document.getElementById('stock-list');
  const empty  = document.getElementById('empty-state');
  const prevTickers = new Set(STATE.renderedTickers);

  if (!stocks.length) {
    list.innerHTML = '';
    empty.style.display = 'flex';
    STATE.renderedTickers = [];
    return;
  }
  empty.style.display = 'none';

  const newTickers = stocks.map(s => s.ticker);
  STATE.renderedTickers = newTickers;

  // Update STOCK_MAP
  stocks.forEach(s => { STOCK_MAP[s.ticker] = s; });

  // Preserve open cards across re-renders
  const openCards = new Set();
  document.querySelectorAll('.card-detail.open').forEach(d => {
    const card = d.closest('.stock-card');
    if (card) openCards.add(card.dataset.ticker);
  });

  list.innerHTML = stocks.map(s => buildCardHtml(s, openCards.has(s.ticker), !prevTickers.has(s.ticker))).join('');
  updateTimestamp();
}

// ── CARD HTML ────────────────────────────────────────────
const CAT_COLORS = { FDA:'#00e676', Earnings:'#c084fc', 'M&A':'#ff4060', Contract:'#00d4ff', Partnership:'#00b8d9', 'SEC Filing':'#ffcc00' };
const CAT_CSS    = { FDA:'cat-fda', Earnings:'cat-earnings', 'M&A':'cat-ma', Contract:'cat-contract', Partnership:'cat-partner', 'SEC Filing':'cat-sec' };

function buildCardHtml(s, isOpen = false, isNew = false) {
  const gap      = (s.gapPct || 0).toFixed(1);
  const gapCls   = s.gapPct < 0 ? 'neg' : s.gapPct >= 20 ? 'tier3' : '';
  const floatM   = s.floatShares ? (s.floatShares / 1e6).toFixed(1) : null;
  const floatCls = s.floatShares < 10e6 ? (s.floatShares < 5e6 ? 'ultra-float uf' : 'low-float lf') : '';
  const tickCls  = s.floatShares < 5e6 ? 'ultra-float' : s.floatShares < 10e6 ? 'low-float' : '';
  const rvol     = s.rvol ? s.rvol.toFixed(1) + 'x' : '—';
  const chg      = s.change != null ? ((s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%') : '';
  const chgCls   = s.change >= 0 ? 'pos' : 'neg';
  const stale    = s.priceStale ? '<span class="price-stale-chip">⚠ Stale</span>' : '';
  const aScore   = scoreASetup(s);
  const asetupCls = aScore > 0 ? 'asetup-active' : '';
  const pmhCls   = s.pmHigh && s.price > s.pmHigh ? 'pmh-active' : '';
  const newCls   = isNew ? 'card-new' : '';

  const asetupBanner = aScore > 0 ? `<div class="asetup-banner"><span class="as-star">★</span> A-SETUP <span class="as-score">${aScore}/5</span></div>` : '';

  const catChip = s.catalyst
    ? `<span class="catalyst-chip ${CAT_CSS[s.catalyst.type] || 'no-catalyst'}">${s.catalyst.type}</span>`
    : `<span class="catalyst-chip no-catalyst">No Catalyst</span>`;

  const ez = calcEntryZone(s);
  const ezHtml = ez ? `
    <div class="entry-zone">
      <div class="ez-title">⚡ Entry Zone</div>
      <div class="ez-grid">
        <div class="ez-item"><div class="ez-label">Entry</div><div class="ez-val entry">$${ez.entryHigh.toFixed(2)}</div></div>
        <div class="ez-item"><div class="ez-label">Stop</div><div class="ez-val stop">$${ez.stop.toFixed(2)}</div></div>
        <div class="ez-item"><div class="ez-label">Target 2R</div><div class="ez-val target">$${ez.target.toFixed(2)}</div></div>
        <div class="ez-item"><div class="ez-label">R:R</div><div class="ez-val rr">1:2</div></div>
      </div>
    </div>` : '';

  return `
<div class="stock-card ${asetupCls} ${pmhCls} ${newCls}" id="card-${s.ticker}" data-ticker="${s.ticker}" onclick="toggleCard('${s.ticker}')">
  ${asetupBanner}
  <div class="card-main">
    <div class="card-ticker-col">
      <div class="card-ticker ${tickCls}">${s.ticker}</div>
      ${floatM ? `<div class="card-float-tag ${floatCls}">${floatM}M <span class="float-est">(est.)</span></div>` : ''}
    </div>
    <div class="card-middle">
      <div class="card-price-row">
        <span class="card-price">$${(s.price || 0).toFixed(2)}</span>
        ${chg ? `<span class="card-chg ${chgCls}">${chg}</span>` : ''}
        ${stale}
        <span class="card-sizeit" onclick="event.stopPropagation();openSizerWithPrice(${s.price||0})">🧮 Size</span>
      </div>
      <div class="card-stats-row">
        <span class="card-stat">RVOL <span class="${s.rvol >= 10 ? 'hig' : s.rvol >= 5 ? 'hi' : ''}">${rvol}</span></span>
        <span class="card-stat">VOL <span>${fmt(s.volume)}</span></span>
      </div>
      <div class="card-cat-row">${catChip}</div>
    </div>
    <div class="card-right">
      <div class="card-gap ${gapCls}">${s.gapPct >= 0 ? '+' : ''}${gap}%</div>
      ${s.pmHigh ? `<div class="pmh-tag">PMH $${s.pmHigh.toFixed(2)}</div>` : ''}
    </div>
  </div>
  <div class="card-detail ${isOpen ? 'open' : ''}" id="detail-${s.ticker}">
    <div class="detail-grid">
      <div class="dg-item"><div class="dg-label">Prev Close</div><div class="dg-val">$${(s.prevClose||0).toFixed(2)}</div></div>
      <div class="dg-item"><div class="dg-label">Volume</div><div class="dg-val">${fmt(s.volume)}</div></div>
      <div class="dg-item"><div class="dg-label">Market Cap</div><div class="dg-val">${fmt(s.marketCap)}</div></div>
      <div class="dg-item"><div class="dg-label">Avg Vol</div><div class="dg-val">${fmt(s.avgVolume)}</div></div>
    </div>
    ${ezHtml}
    ${buildNewsHtml(s)}
    <div class="chart-section">
      <div class="chart-header">
        <div class="chart-header-left">
          <div class="chart-label">Chart</div>
          <div class="tf-toggle">
            <div class="tf-btn active" onclick="event.stopPropagation();setChartTf('${s.ticker}','1Min',this)">1m</div>
            <div class="tf-btn" onclick="event.stopPropagation();setChartTf('${s.ticker}','5Min',this)">5m</div>
          </div>
        </div>
      </div>
      <div class="chart-wrap" id="chart-wrap-${s.ticker}">
        <div class="chart-loading" id="chart-loading-${s.ticker}">
          <span class="cl-dot"></span><span class="cl-dot"></span><span class="cl-dot"></span><span>Loading...</span>
        </div>
      </div>
      <div class="chart-tags" id="chart-tags-${s.ticker}"></div>
    </div>
    <div class="action-row">
      <a class="act-btn google-btn" href="https://news.google.com/search?q=${encodeURIComponent(s.ticker+' stock')}" target="_blank" onclick="event.stopPropagation()">🔍 Google News</a>
      <a class="act-btn" href="https://finance.yahoo.com/quote/${s.ticker}" target="_blank" onclick="event.stopPropagation()">📊 Yahoo</a>
    </div>
    <button class="card-buy-btn" id="buy-btn-${s.ticker}" onclick="event.stopPropagation();openConfirmSheet('${s.ticker}')">
      ⚡ BUY ${s.ticker}
    </button>
  </div>
</div>`;
}

function toggleCard(ticker) {
  const detail = document.getElementById('detail-' + ticker);
  if (!detail) return;
  const opening = !detail.classList.contains('open');
  detail.classList.toggle('open', opening);
  if (opening) loadChart(ticker);
}

function patchCardData(cardEl, s) {
  const priceEl = cardEl.querySelector('.card-price');
  const chgEl   = cardEl.querySelector('.card-chg');
  const gapEl   = cardEl.querySelector('.card-gap');
  if (priceEl) priceEl.textContent = '$' + (s.price || 0).toFixed(2);
  if (chgEl && s.change != null) {
    chgEl.textContent = (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%';
    chgEl.className = 'card-chg ' + (s.change >= 0 ? 'pos' : 'neg');
  }
  if (gapEl) {
    const gap = (s.gapPct || 0).toFixed(1);
    gapEl.textContent = (s.gapPct >= 0 ? '+' : '') + gap + '%';
    gapEl.className = 'card-gap ' + (s.gapPct < 0 ? 'neg' : s.gapPct >= 20 ? 'tier3' : '');
  }
  // A-setup banner
  const banner = cardEl.querySelector('.asetup-banner');
  const aScore = scoreASetup(s);
  if (aScore > 0 && !banner) {
    const main = cardEl.querySelector('.card-main');
    if (main) main.insertAdjacentHTML('beforebegin', `<div class="asetup-banner"><span class="as-star">★</span> A-SETUP <span class="as-score">${aScore}/5</span></div>`);
    cardEl.classList.add('asetup-active');
  } else if (aScore === 0 && banner) {
    banner.remove();
    cardEl.classList.remove('asetup-active');
  }
  refreshBuyBtn(s.ticker);
}

function refreshBuyBtn(ticker) {
  const btn = document.getElementById('buy-btn-' + ticker);
  if (!btn) return;
  const pos = EXEC_STATE.position;
  const inPos = pos && pos.ticker === ticker && pos.state !== 'IDLE' && pos.state !== 'CLOSED';
  btn.disabled = !!inPos;
  btn.textContent = inPos ? '⏳ Position Active' : `⚡ BUY ${ticker}`;
}

// ── A-SETUP SCORING ──────────────────────────────────────
function scoreASetup(s) {
  if (!s) return 0;
  let score = 0;
  if (s.floatShares > 0 && s.floatShares < 10_000_000) score++;
  if (s.rvol != null && s.rvol >= 5) score++;
  if (s.gapPct != null && s.gapPct >= 10) score++;
  if (s.catalyst) score++;
  if (s.pmHigh && s.price > s.pmHigh) score++;
  return score;
}

// ── ENTRY ZONE ───────────────────────────────────────────
function calcEntryZone(s) {
  if (!s.pmHigh || !s.pmLow || s.pmHigh <= 0) return null;
  const entryHigh = parseFloat((s.pmHigh * 1.005).toFixed(2));
  const entryLow  = parseFloat((s.pmHigh * 0.995).toFixed(2));
  const stop      = parseFloat((s.pmLow  * 0.98).toFixed(2));
  const rDist     = entryHigh - stop;
  const target    = parseFloat((entryHigh + rDist * 2).toFixed(2));
  return { entryHigh, entryLow, stop, target };
}

// ── SKELETON + SCANNING STATE ────────────────────────────
function showSkeletons() {
  if (STATE.renderedTickers.length > 0) return;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('stock-list').innerHTML = [0,1,2,3,4].map((_, i) =>
    `<div class="skeleton-card" style="animation-delay:${i*0.1}s">
      <div class="skel-ticker"></div>
      <div class="skel-body"><div class="skel-line w75"></div><div class="skel-line w40"></div><div class="skel-line w60"></div></div>
      <div class="skel-right"></div>
    </div>`
  ).join('');
}

function setScanningState(state) {
  const el = document.getElementById('stat-scanning');
  if (!el) return;
  if (state === 'scanning') {
    if (el.querySelector('.scanning-pulse')) return;
    el.innerHTML = '<span class="scanning-pulse"><span class="sp-dot"></span><span class="sp-dot"></span><span class="sp-dot"></span></span>';
  } else {
    el.textContent = '8,400+';
  }
}

// ── NEWS ─────────────────────────────────────────────────
function isNewsRecent(publishedAt) {
  if (!publishedAt) return false;
  return (Date.now() - new Date(publishedAt).getTime()) < 48 * 60 * 60 * 1000;
}

function sentimentMeta(s) {
  const m = { positive:{cls:'nsb-positive',emoji:'▲'}, negative:{cls:'nsb-negative',emoji:'▼'}, neutral:{cls:'nsb-neutral',emoji:'◆'} };
  return m[s] || null;
}

function buildNewsHtml(s) {
  const news = s.news || [];
  if (!news.length) return `<div class="no-news">No news via API.<br/>
    <a href="https://news.google.com/search?q=${encodeURIComponent(s.ticker+' stock')}" target="_blank">🔍 Google News</a>
    &nbsp;&nbsp;
    <a href="https://www.benzinga.com/stock/${s.ticker.toLowerCase()}" target="_blank">📰 Benzinga</a>
  </div>`;

  const items = news.slice(0, 3).map(n => {
    const catColor = n.catalyst ? (CAT_COLORS[n.catalyst.type] || '#6a90b0') : '#6a90b0';
    const isRecent = isNewsRecent(n.publishedAt);
    const url = n.url && n.url !== '#' ? n.url : 'https://news.google.com/search?q=' + encodeURIComponent((s.ticker||'') + ' ' + (n.headline||''));
    const sm = n.sentiment ? sentimentMeta(n.sentiment) : null;
    const sentBadge = sm ? `<span class="news-sentiment-badge ${sm.cls}">${sm.emoji} ${n.sentiment}</span>` : '';
    return `<a class="news-card ${n.sentiment ? 'sent-'+n.sentiment : ''}" href="${url}" target="_blank" onclick="event.stopPropagation()" style="${isRecent ? '' : 'opacity:0.5'}">
      <div class="news-card-top">
        <div class="news-cat-dot" style="background:${catColor}"></div>
        <div class="news-headline">${n.headline || 'View article'}${!isRecent ? ' <span style="color:var(--dim);font-size:9px">(older)</span>' : ''}</div>
      </div>
      <div class="news-meta">
        <span class="news-source">${n.source || 'News'}</span>
        ${sentBadge}
        <span class="news-time">${n.timeAgo || ''}</span>
      </div>
      <div class="news-link-row">🔗 Tap to read full article</div>
    </a>`;
  }).join('');

  const hasNews = news.length > 0;
  const catLabel = s.catalyst ? s.catalyst.type : 'News';
  return `<div class="news-dropdown" id="news-drop-${s.ticker}">
    <div class="news-dropdown-tab" onclick="event.stopPropagation();this.closest('.news-dropdown').classList.toggle('open')">
      <span class="ndt-icon">📰</span>
      <span class="ndt-label">${catLabel}</span>
      ${hasNews ? `<span class="ndt-chip ${s.catalyst ? CAT_CSS[s.catalyst.type]||'' : ''}">${news.length} article${news.length!==1?'s':''}</span>` : ''}
      <span class="ndt-arrow">▼</span>
    </div>
    <div class="news-dropdown-body">${items}</div>
  </div>`;
}

// ── CHART ────────────────────────────────────────────────
const CC = {
  grid:'rgba(30,45,66,0.8)', candleUp:'#00e676', candleDown:'#ff4060',
  wickUp:'#00e676', wickDown:'#ff4060', volUp:'rgba(0,230,118,0.35)', volDown:'rgba(255,64,96,0.35)',
  pmHigh:'#ffcc00', orbLine:'#00d4ff', stopLine:'#ff4060', targetLine:'#00e676',
  currentPrice:'rgba(255,255,255,0.7)', entryFill:'rgba(0,212,255,0.06)',
  orbBox:'rgba(0,212,255,0.04)', orbBorder:'rgba(0,212,255,0.2)',
  fcGreen:'rgba(0,230,118,0.3)', fcRed:'rgba(255,64,96,0.3)',
  lblBg:'#0d1219', dimText:'rgba(106,144,176,0.8)',
};

function toEtHourFE(isoStr) {
  const d = new Date(isoStr);
  const s = d.toLocaleString('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const [h, m, sec] = s.split(':').map(Number);
  return h + m/60 + sec/3600;
}

function aggregateBars(bars1m, minutes) {
  if (minutes <= 1) return bars1m;
  const out = []; let bucket = null, bucketEnd = null;
  for (const b of bars1m) {
    const t = new Date(b.t).getTime();
    if (!bucket || t >= bucketEnd) {
      if (bucket) out.push(bucket);
      bucket = { t:b.t, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v };
      bucketEnd = t + minutes * 60 * 1000;
    } else {
      bucket.h = Math.max(bucket.h, b.h);
      bucket.l = Math.min(bucket.l, b.l);
      bucket.c = b.c; bucket.v += b.v;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

function setChartTf(ticker, tf, btnEl) {
  STATE.chartTf[ticker] = tf;
  const wrap = btnEl.closest('.tf-toggle');
  wrap?.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  btnEl.classList.add('active');
  const cached = CHART_CACHE[ticker];
  if (cached?.data) {
    const canvas = document.querySelector(`#chart-wrap-${ticker} .chart-canvas`);
    if (canvas) drawChart(canvas, cached.data, tf);
  }
}

async function loadChart(ticker) {
  const CACHE_TTL = 5 * 60 * 1000;
  const cached = CHART_CACHE[ticker];
  if (cached && (Date.now() - cached.fetchedAt < CACHE_TTL)) { renderChartFromData(ticker, cached.data); return; }
  const loadEl = document.getElementById('chart-loading-' + ticker);
  const wrapEl = document.getElementById('chart-wrap-' + ticker);
  if (!wrapEl) return;
  if (loadEl) { loadEl.style.display = 'flex'; loadEl.innerHTML = '<span class="cl-dot"></span><span class="cl-dot"></span><span class="cl-dot"></span><span>Loading...</span>'; }
  try {
    const res  = await apiFetch(`/api/chart/${ticker}`);
    const data = await res.json();
    CHART_CACHE[ticker] = { fetchedAt: Date.now(), data };
    renderChartFromData(ticker, data);
  } catch (err) {
    if (err.message === 'Unauthenticated') return;
    if (loadEl) { loadEl.style.display = 'flex'; loadEl.innerHTML = '<span style="color:var(--red)">Chart unavailable</span>'; }
  }
}

function renderChartFromData(ticker, data) {
  const wrapEl = document.getElementById('chart-wrap-' + ticker);
  const loadEl = document.getElementById('chart-loading-' + ticker);
  const tagsEl = document.getElementById('chart-tags-' + ticker);
  if (!wrapEl) return;
  if (data.noData || !data.bars?.length) {
    if (loadEl) loadEl.style.display = 'none';
    let nd = wrapEl.querySelector('.chart-no-data');
    if (!nd) { nd = document.createElement('div'); nd.className = 'chart-no-data'; wrapEl.appendChild(nd); }
    nd.textContent = data.message || 'No chart data yet — check back after 4am ET';
    return;
  }
  if (loadEl) loadEl.style.display = 'none';
  wrapEl.querySelector('.chart-no-data')?.remove();
  let canvas = wrapEl.querySelector('.chart-canvas');
  if (!canvas) { canvas = document.createElement('canvas'); canvas.className = 'chart-canvas'; wrapEl.appendChild(canvas); }
  const tf = STATE.chartTf[ticker] || '1Min';
  drawChart(canvas, data, tf);
  if (tagsEl) {
    const tags = [];
    if (data.goNoGo === 'GO')      tags.push('<div class="go-verdict go">🚀 GO</div>');
    if (data.goNoGo === 'NO-GO')   tags.push('<div class="go-verdict nogo">✋ NO-GO</div>');
    if (data.goNoGo === 'PENDING') tags.push('<div class="go-verdict pending">⏳ PENDING</div>');
    if (data.gapAndGo)  tags.push('<div class="chart-tag tag-gng">Gap & Go</div>');
    if (data.orb)       tags.push('<div class="chart-tag tag-orb">ORB</div>');
    if (data.pmHigh)    tags.push(`<div class="chart-tag tag-pmh">PMH $${data.pmHigh.toFixed(2)}</div>`);
    tagsEl.innerHTML = tags.join('');
  }
  refreshBuyBtn(ticker);
}

function drawChart(canvas, data, tf = '1Min') {
  const { pmHigh, currentPrice, orb, entryZone, firstCandle, gapAndGo } = data;
  const bars = tf === '5Min' ? aggregateBars(data.bars, 5) : data.bars;
  if (!bars || !bars.length) return;
  const DPR = window.devicePixelRatio || 1;
  const W_CSS = canvas.parentElement.clientWidth || 340;
  const CHART_H = 200, VOL_H = 40, TOTAL_H = CHART_H + VOL_H;
  const PAD_L = 4, PAD_R = 50, PAD_T = 14, PAD_B = 2;
  canvas.width  = Math.round(W_CSS * DPR);
  canvas.height = Math.round(TOTAL_H * DPR);
  canvas.style.height = TOTAL_H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);
  const W = W_CSS, H = TOTAL_H;
  let pMin = Infinity, pMax = -Infinity;
  for (const b of bars) { if (b.l < pMin) pMin = b.l; if (b.h > pMax) pMax = b.h; }
  if (pmHigh)         pMax = Math.max(pMax, pmHigh);
  if (currentPrice)   { pMax = Math.max(pMax, currentPrice); pMin = Math.min(pMin, currentPrice); }
  if (entryZone?.stop)   pMin = Math.min(pMin, entryZone.stop);
  if (entryZone?.target) pMax = Math.max(pMax, entryZone.target);
  const pad = (pMax - pMin) * 0.06 || 0.05;
  pMin -= pad; pMax += pad;
  const pRange = pMax - pMin;
  const maxVol = Math.max(...bars.map(b => b.v), 1);
  const chartTop = PAD_T, chartBottom = CHART_H - PAD_B, chartH = chartBottom - chartTop;
  const cLeft = PAD_L, cRight = W - PAD_R, cArea = cRight - cLeft;
  const pToY = p => chartTop + chartH * (1 - (p - pMin) / pRange);
  const slotW = cArea / bars.length;
  const bodyW = Math.max(1, Math.floor(slotW) - (slotW > 3 ? 1 : 0));
  const barX  = i => cLeft + i * slotW + (slotW - bodyW) / 2;
  const barCX = i => cLeft + i * slotW + slotW / 2;

  ctx.fillStyle = '#0d1219'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = CC.grid; ctx.lineWidth = 0.5;
  for (let g = 0; g <= 4; g++) { const y = chartTop + (chartH / 4) * g; ctx.beginPath(); ctx.moveTo(cLeft, y); ctx.lineTo(cRight, y); ctx.stroke(); }

  // Volume bars
  const vTop = CHART_H, vBot = H - 2, vH = vBot - vTop;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], isUp = b.c >= b.o;
    const bH = maxVol > 0 ? (b.v / maxVol) * vH : 0;
    ctx.fillStyle = isUp ? CC.volUp : CC.volDown;
    ctx.fillRect(barX(i), vBot - bH, bodyW, bH);
  }
  // Candles
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], isUp = b.c >= b.o;
    const x = barX(i), cx = barCX(i);
    ctx.strokeStyle = isUp ? CC.wickUp : CC.wickDown; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, pToY(b.h)); ctx.lineTo(cx, pToY(b.l)); ctx.stroke();
    ctx.fillStyle = isUp ? CC.candleUp : CC.candleDown;
    ctx.fillRect(x, Math.min(pToY(b.o), pToY(b.c)), bodyW, Math.max(1, Math.abs(pToY(b.c) - pToY(b.o))));
  }

  function hLine(price, color, label, dash = []) {
    if (!price || price <= 0) return;
    const y = pToY(price);
    if (y < chartTop - 2 || y > chartBottom + 2) return;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1;
    if (dash.length) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(cLeft, y); ctx.lineTo(cRight, y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = CC.lblBg; ctx.fillRect(cRight + 1, y - 7, PAD_R - 2, 14);
    ctx.fillStyle = color; ctx.font = "500 9px 'DM Mono',monospace"; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('$' + price.toFixed(2), cRight + 3, y);
    if (label) { ctx.fillStyle = CC.lblBg; ctx.fillRect(cLeft, y - 7, label.length * 5 + 8, 14); ctx.fillStyle = color; ctx.font = "400 8px 'DM Mono',monospace"; ctx.fillText(label, cLeft + 3, y); }
    ctx.restore();
  }

  if (pmHigh)         hLine(pmHigh, CC.pmHigh, 'PMH');
  if (entryZone)      { hLine(entryZone.entryHigh, CC.orbLine, 'ENTRY', [3,3]); hLine(entryZone.stop, CC.stopLine, 'STOP', [3,3]); hLine(entryZone.target, CC.targetLine, '2R', [3,3]); }
  if (orb)            hLine(orb.breakoutLevel, CC.orbLine, 'ORB', [4,4]);
  if (currentPrice)   hLine(currentPrice, CC.currentPrice, 'NOW');

  // Axis labels
  ctx.fillStyle = CC.dimText; ctx.font = "400 8px 'DM Mono',monospace"; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) { const p = pMin + (pRange / 4) * g; ctx.fillText('$' + p.toFixed(2), W - 2, pToY(p)); }
}

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h); ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}
