/* ── app.js — state, auth, API, WebSocket, nav, clock ── */

'use strict';

// ── CONFIG ────────────────────────────────────────────────
const BACKEND    = '';
const WS_BACKEND = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

// ── STATE ────────────────────────────────────────────────
const STATE = {
  stocks:        [],
  currentPage:   'scanner',
  isLive:        false,
  refreshRate:   30000,
  refreshTimer:  null,
  renderedTickers: [],
  chartTf:       {},
  filters: {
    priceMin:      0.50,
    priceMax:      25,
    gapMin:        5,
    floatMax:      20_000_000,
    dollarVolMin:  0,
    floatRotMin:   0,
    catalyst:      false,
  },
  presets: {
    firstleg: { priceMin:0.50, priceMax:10,  gapMin:10, floatMax:10_000_000, dollarVolMin:0, floatRotMin:0 },
    premarkt: { priceMin:0.50, priceMax:25,  gapMin:5,  floatMax:20_000_000, dollarVolMin:0, floatRotMin:0 },
    midday:   { priceMin:1,    priceMax:25,  gapMin:3,  floatMax:50_000_000, dollarVolMin:0, floatRotMin:0 },
  },
};

const EXEC_STATE = {
  position:  null,
  currentPx: {},
};

const STOCK_MAP  = {};
const CHART_CACHE = {};

// ── AUTH ────────────────────────────────────────────────
let _authToken = '';
let _authSetAt = 0;        // timestamp when token was set
let _bootComplete = false; // true once bootApp() finishes initial setup

function getWsToken() {
  return _authToken;
}

async function apiFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (_authToken) headers['Authorization'] = 'Bearer ' + _authToken;
  const res = await fetch(BACKEND + url, { ...opts, headers });
  if (res.status === 401) {
    // Only kick to login if boot is complete AND token is at least 5s old.
    // Prevents a slow /api/journal or /api/execution/position during boot
    // from bouncing the user back immediately after a valid login.
    if (_bootComplete && (Date.now() - _authSetAt > 5000)) {
      handleUnauth();
    }
    throw new Error('Unauthenticated');
  }
  return res;
}

function handleUnauth() {
  _authToken   = '';
  _authSetAt   = 0;
  _bootComplete = false;
  document.getElementById('login-screen').classList.remove('hidden');
}

async function submitLogin() {
  const input = document.getElementById('login-passphrase');
  const btn   = document.getElementById('login-btn');
  const err   = document.getElementById('login-error');
  const spin  = document.getElementById('login-spinner');
  const pass  = input.value.trim();
  if (!pass) return;
  btn.disabled = true;
  spin.style.display = 'block';
  err.textContent = '';
  input.classList.remove('error');
  try {
    const res  = await fetch(BACKEND + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: pass }),
    });
    const data = await res.json();
    if (!res.ok) { input.classList.add('error'); err.textContent = data.error || 'Invalid passphrase'; return; }
    _authToken = data.token;
    _authSetAt = Date.now();
    document.getElementById('login-screen').classList.add('hidden');
    bootApp();
  } catch (e) {
    err.textContent = 'Connection error';
  } finally {
    btn.disabled = false;
    spin.style.display = 'none';
  }
}

// ── CLOCK + MARKET STATUS ────────────────────────────────
function updateClock() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  document.getElementById('clock').textContent = etStr;

  const [h, m] = etStr.split(':').map(Number);
  const mins = h * 60 + m;
  let label, dotCls;
  if      (mins >= 240 && mins < 570)  { label = 'PRE-MARKET';   dotCls = 'pre'; }
  else if (mins >= 570 && mins < 960)  { label = 'MARKET OPEN';  dotCls = 'live'; }
  else if (mins >= 960 && mins < 1200) { label = 'AFTER HOURS';  dotCls = 'pre'; }
  else                                  { label = 'CLOSED';        dotCls = ''; }

  document.getElementById('mpill-label').textContent = STATE.isLive ? label : 'CONNECTING';
  document.getElementById('mpill-dot').className = 'mpill-dot ' + (STATE.isLive ? dotCls : '');

  // Update exec countdown if on trade page
  if (STATE.currentPage === 'trade') {
    const cdEl = document.querySelector('.exec-countdown');
    if (cdEl) cdEl.outerHTML = buildCountdownHtml();
  }
}

// ── NAV ────────────────────────────────────────────────
function showPage(name) {
  STATE.currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const page = document.getElementById('page-' + name);
  const btn  = document.getElementById('nav-' + name);
  if (page) page.classList.add('active');
  if (btn)  btn.classList.add('active');

  // Show/hide filter bar only for scanner
  document.getElementById('filter-bar').style.display = name === 'scanner' ? '' : 'none';

  if (name === 'trade')   { renderTradeTab(); }
  if (name === 'journal') { renderJournal(); }
  if (name === 'pulse')   { fetchPulse(); }
}

// ── WEBSOCKET ───────────────────────────────────────────
function connectWS() {
  const token = getWsToken();
  if (!token) return;
  try {
    const ws = new WebSocket(WS_BACKEND + '?token=' + encodeURIComponent(token));
    ws.onopen = () => { updateConnStatus(true); updateClock(); };
    ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'scan_results' && Array.isArray(msg.data) && msg.data.length > 0) {
          if (msg.data[0].ticker?.startsWith('DEMO')) return;
          STATE.stocks = msg.data;
          STATE.isLive = true;
          applyFilters();
          setScanningState('done');
        }
        if (msg.type === 'price_update' && msg.data) {
          let any = false;
          for (const stock of STATE.stocks) {
            const u = msg.data[stock.ticker];
            if (!u) continue;
            stock.price = u.price;
            stock.priceStale = u.priceStale;
            if (stock.prevClose > 0) stock.change = parseFloat(((u.price - stock.prevClose) / stock.prevClose * 100).toFixed(2));
            stock.aSetup = scoreASetup(stock);
            any = true;
            EXEC_STATE.currentPx[stock.ticker] = u.price;
            const cardEl = document.getElementById('card-' + stock.ticker);
            if (cardEl) patchCardData(cardEl, stock);
          }
          if (any) { updateTimestamp(); updateLivePnl(); }
        }
        if (msg.type === 'order_update') {
          EXEC_STATE.position = msg.data;
          if (STATE.currentPage === 'trade') renderExecSection();
          updateExecNavDot();
          STATE.renderedTickers.forEach(t => refreshBuyBtn(t));
        }
      } catch (_) {}
    };
    ws.onclose = e => {
      if (e.code === 4401) { handleUnauth(); return; }
      updateConnStatus(false);
      setTimeout(connectWS, 5000);
    };
    ws.onerror = () => {};
  } catch (_) {}
}

function updateConnStatus(live) {
  STATE.isLive = live;
  document.getElementById('conn-badge').className = 'status-badge ' + (live ? 'live' : 'demo');
  document.getElementById('conn-label').textContent = live ? 'Live' : 'Connecting';
}

// ── FETCH ────────────────────────────────────────────────
async function fetchLiveData() {
  setScanningState('scanning');
  showSkeletons();
  try {
    const p = new URLSearchParams({
      priceMin:     STATE.filters.priceMin,
      priceMax:     STATE.filters.priceMax,
      dollarVolMin: STATE.filters.dollarVolMin,
      floatRotMin:  STATE.filters.floatRotMin,
      gapMin:       STATE.filters.gapMin,
      floatMax:     STATE.filters.floatMax,
    });
    const res = await apiFetch('/api/scanner?' + p);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      if (Array.isArray(data)) { STATE.isLive = true; updateConnStatus(true); applyFilters(); }
      return;
    }
    if (data[0].ticker?.startsWith('DEMO')) { setScanningState('done'); return; }
    STATE.stocks = data;
    STATE.isLive = true;
    updateConnStatus(true);
    applyFilters();
    setScanningState('done');
  } catch (e) {
    if (e.message !== 'Unauthenticated') console.warn('[Fetch]', e.message);
  }
}

function manualRefresh() { fetchLiveData(); }

// ── SETTINGS ────────────────────────────────────────────
function openSettings()  { document.getElementById('settings-overlay').classList.add('open'); }
function closeSettings() { document.getElementById('settings-overlay').classList.remove('open'); }

function setRefreshRate(ms) {
  const labels = { 8000:'8s', 15000:'15s', 30000:'30s', 60000:'60s' };
  document.querySelectorAll('.rate-pill').forEach(p => p.classList.toggle('active', p.textContent === labels[ms]));
  clearInterval(STATE.refreshTimer);
  STATE.refreshRate = ms;
  STATE.refreshTimer = setInterval(fetchLiveData, ms);
}

async function fetchAndShow(url, title) {
  closeSettings();
  document.getElementById('api-result-title').querySelector('span').textContent = title;
  const body = document.getElementById('api-result-body');
  body.textContent = 'Loading...';
  document.getElementById('api-result-overlay').style.display = 'flex';
  try {
    const res  = await apiFetch(url);
    const data = await res.json();
    body.textContent = JSON.stringify(data, null, 2);
    const prefix = url.includes('health') ? (data.status === 'ok' ? '✅ ' : '❌ ') : '';
    document.getElementById('api-result-title').querySelector('span').textContent = prefix + title;
  } catch (e) {
    body.textContent = 'Error: ' + e.message;
  }
}
function closeApiResult() { document.getElementById('api-result-overlay').style.display = 'none'; }

// ── BOOT ────────────────────────────────────────────────
function bootApp() {
  journalLoad();
  updateClock();
  setInterval(updateClock, 1000);
  initFilterBar();
  initSizer();
  showPage('scanner');
  fetchLiveData();
  connectWS();
  STATE.refreshTimer = setInterval(fetchLiveData, STATE.refreshRate);
  apiFetch('/api/execution/position')
    .then(r => r.json())
    .then(pos => { EXEC_STATE.position = pos; updateExecNavDot(); })
    .catch(() => {});
  // Mark boot complete after a generous delay — any 401s before this are ignored
  setTimeout(() => { _bootComplete = true; }, 6000);
}

function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  updateClock();
  setInterval(updateClock, 1000);
  setTimeout(() => document.getElementById('login-passphrase')?.focus(), 100);
}

// ── HELPERS ──────────────────────────────────────────────
function fmt(n)  { if (!n && n !== 0) return '—'; if (n >= 1e9) return (n/1e9).toFixed(1)+'B'; if (n >= 1e6) return (n/1e6).toFixed(1)+'M'; if (n >= 1e3) return (n/1e3).toFixed(0)+'K'; return n.toString(); }
function fmtD(n) { return '$' + (Math.abs(n) >= 1000 ? Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : Math.abs(n).toFixed(2)); }

function updateTimestamp() {
  const now = new Date();
  const t = now.toLocaleString('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Updated ' + t + ' ET';
}

function updateExecNavDot() {
  const btn = document.getElementById('nav-trade');
  if (!btn) return;
  const pos = EXEC_STATE.position;
  const active = pos && pos.state !== 'IDLE' && pos.state !== 'CLOSED';
  let dot = btn.querySelector('.exec-nav-dot');
  if (active && !dot) { dot = document.createElement('div'); dot.className = 'exec-nav-dot'; btn.appendChild(dot); }
  else if (!active && dot) { dot.remove(); }
}

init();
