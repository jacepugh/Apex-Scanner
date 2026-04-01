/**
 * APEX SCANNER — Backend Server
 * Node.js + Express + WebSocket
 *
 * SCAN ARCHITECTURE (Phase 0)
 * ---------------------------
 * Two independent timers run during trading hours:
 *
 *   Discovery timer  — full scan + enrichment, updates store pool
 *     · 60s  pre-market  (4:00–9:29am ET)
 *     · 30s  market open (9:30–10:30am ET)
 *     · 120s after-hours
 *     · broadcasts: scan_results, alerts
 *
 *   Price refresh timer — lightweight price-only update for displayed tickers
 *     · 10s  pre-market
 *     · 5s   market open (9:30–10:30am ET)
 *     · paused after 10:30am and when market closed
 *     · broadcasts: price_update (small payload, no enrichment)
 *
 * Both timers pause when market is closed and resume at pre-market open.
 * Market session logic lives in scanner.getMarketSession() — single source
 * of truth, not duplicated here.
 */

'use strict';

const express   = require('express');
const axios     = require('axios');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');

const scannerRoutes = require('./routes/scanner');
const newsRoutes    = require('./routes/news');
const alertRoutes   = require('./routes/alerts');

process.env.DATA_SOURCE = 'polygon';

const { ScannerService, POOL_FILTERS } = require('./services/scanner');
const { NewsService }                  = require('./services/news');
const { CacheService }                 = require('./services/cache');
const store                            = require('./services/store');

require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  message:  { error: 'Too many requests, slow down.' },
}));

// ─── SERVICES ────────────────────────────────────────────────────────────────

const cache   = new CacheService();
const news    = new NewsService({ cache, apiKey: process.env.NEWS_API_KEY });
const scanner = new ScannerService({ cache, news });

app.locals.scanner   = scanner;
app.locals.news      = news;
app.locals.cache     = cache;
app.locals.wss       = wss;
app.locals.store     = store;

// ─── ROUTES ──────────────────────────────────────────────────────────────────

app.use('/api/scanner', scannerRoutes);
app.use('/api/news',    newsRoutes);
app.use('/api/alerts',  alertRoutes);
app.use('/api/pulse',   require('./routes/pulse'));
app.use('/api/journal', require('./routes/journal'));

// Pulse snapshot — must register before the wildcard below
app.get('/api/pulse/all', (req, res) => res.json(pulseStore));

app.get('/api/health', (req, res) => {
  const session = scanner.getMarketSession();
  res.json({
    status:          'ok',
    uptime:          process.uptime(),
    timestamp:       new Date().toISOString(),
    dataSource:      process.env.DATA_SOURCE || 'demo',
    session,
    store:           store.stats(),
    priceRefreshAge: store.priceRefreshAge(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── WEBSOCKET ───────────────────────────────────────────────────────────────

const wsClients = new Map();

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).slice(2);
  wsClients.set(clientId, { ws, filters: {} });
  console.log(`[WS] Client connected: ${clientId} (total: ${wsClients.size})`);
  ws.send(JSON.stringify({ type: 'connected', clientId }));

  if (!store.isEmpty()) {
    ws.send(JSON.stringify({ type: 'scan_results', data: store.get(), timestamp: Date.now() }));
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'set_filters') {
        wsClients.get(clientId).filters = msg.filters;
        ws.send(JSON.stringify({ type: 'filters_ack', filters: msg.filters }));
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.warn('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', () => wsClients.delete(clientId));
  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    wsClients.delete(clientId);
  });
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  let sent  = 0;
  wsClients.forEach(({ ws }, clientId) => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
    else wsClients.delete(clientId);
  });
  return sent;
}
app.locals.broadcast = broadcast;

// ─── POOL FILTERS ────────────────────────────────────────────────────────────
// Phase 1: backend always scans against POOL_FILTERS (wide, 3% gap floor).
// DISPLAY_FILTERS are frontend-only defaults applied at read time via
// applyFilters() in index.html. Never pass DISPLAY_FILTERS to scanner.scan().

// ─── DISCOVERY SCAN ──────────────────────────────────────────────────────────

let scanRunning = false;

async function runScan() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const session = scanner.getMarketSession();

    if (session === 'closed') {
      console.log('[Scan] Market closed — skipping');
      return;
    }

    const results    = await scanner.scan(POOL_FILTERS);
    const isDemoData = results?.length > 0 && results[0].ticker?.startsWith('DEMO');

    if (!isDemoData) {
      store.set(results || [], session);
    }

    if (results?.length > 0 && !isDemoData) {
      broadcast('scan_results', results);

      const alerts = results.filter(s => s.breakingPmh || s.volumeSpike || s.newSetup);
      if (alerts.length > 0) {
        broadcast('alerts', alerts.map(s => ({
          ticker:  s.ticker,
          type:    s.breakingPmh ? 'pmh' : s.volumeSpike ? 'vspike' : 'new',
          price:   s.price,
          message: s.breakingPmh ? `Breaking PM High $${s.pmHigh?.toFixed(2)}`
                 : s.volumeSpike ? 'Vol Spike'
                 : `New setup — Gap ${s.gapPct?.toFixed(1)}%`,
        })));
      }
    }
  } catch (err) {
    console.error('[Scan] Error:', err.message);
  } finally {
    scanRunning = false;
  }
}

function getDiscoveryInterval() {
  const session = scanner.getMarketSession();
  if (session === 'premarket')  return 60_000;
  if (session === 'regular')    return 30_000;
  if (session === 'afterhours') return 120_000;
  return null;
}

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  const interval = getDiscoveryInterval();
  if (!interval) {
    console.log('[Scan Scheduler] Market closed — will recheck in 10 min');
    scanTimer = setTimeout(scheduleScan, 600_000);
    return;
  }
  scanTimer = setTimeout(async () => {
    await runScan();
    scheduleScan();
  }, interval);
}

// ─── FAST PRICE REFRESH ──────────────────────────────────────────────────────

let priceRefreshTimer    = null;
let priceRefreshRunning  = false;

async function runPriceRefresh() {
  if (priceRefreshRunning) return;
  priceRefreshRunning = true;
  try {
    const tickers = store.getDisplayedTickers();
    if (!tickers.length) return;

    const updates = await scanner.refreshPrices(tickers);
    if (Object.keys(updates).length === 0) return;

    store.applyPriceUpdates(updates);
    broadcast('price_update', updates);
  } catch (err) {
    console.error('[Price Refresh] Error:', err.message);
  } finally {
    priceRefreshRunning = false;
  }
}

function getPriceRefreshInterval() {
  const now   = new Date();
  const etH   = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etM   = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  const mins  = etH * 60 + etM;
  if (mins >= 240 && mins < 570)  return 10_000;
  if (mins >= 570 && mins < 630)  return 5_000;
  return null;
}

function schedulePriceRefresh() {
  if (priceRefreshTimer) clearTimeout(priceRefreshTimer);
  const interval = getPriceRefreshInterval();
  if (!interval) {
    priceRefreshTimer = setTimeout(schedulePriceRefresh, 300_000);
    return;
  }
  priceRefreshTimer = setTimeout(async () => {
    await runPriceRefresh();
    schedulePriceRefresh();
  }, interval);
}

// ─── PULSE SCHEDULER ─────────────────────────────────────────────────────────

const PULSE_SYMBOLS = [
  { sym: 'SPY', poly: 'SPY'       },
  { sym: 'QQQ', poly: 'QQQ'       },
  { sym: 'IWM', poly: 'IWM'       },
  { sym: 'VIX', poly: 'I:VIX'    },
  { sym: 'XBI', poly: 'XBI'       },
  { sym: 'BTC', poly: 'X:BTCUSD'  },
];

const pulseStore = {};

async function runPulseFetch() {
  const apiKey = process.env.POLYGON_API_KEY || '';
  if (!apiKey) return;

  for (const { sym, poly } of PULSE_SYMBOLS) {
    if (poly.startsWith('X:')) continue;
    try {
      const url = poly.startsWith('I:')
        ? `https://api.polygon.io/v2/snapshot/locale/us/markets/indices/tickers/${poly}?apiKey=${apiKey}`
        : `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${poly}?apiKey=${apiKey}`;

      const res       = await axios.get(url, { timeout: 8000 });
      const t         = res.data?.ticker || {};
      const day       = t.day     || {};
      const prev      = t.prevDay || {};
      const prevClose = prev.c    || 0;

      let price = 0;
      if (poly.startsWith('I:'))
        price = t.value || t.lastTrade?.p || day.c || 0;
      else
        price = t.lastTrade?.p || t.lastQuote?.P || day.c || prevClose || 0;

      const chgPct = (t.todaysChangePerc != null)
        ? parseFloat(t.todaysChangePerc.toFixed(2))
        : prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;

      if (price > 0) {
        pulseStore[sym] = {
          price:      parseFloat(price.toFixed(2)),
          prevClose:  parseFloat(prevClose.toFixed(2)),
          chgPct,
          updatedAt:  Date.now(),
        };
      }
    } catch (e) { /* keep stale value */ }

    await new Promise(r => setTimeout(r, 300));
  }

  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true',
      { timeout: 8000 }
    );
    const btc = res.data?.bitcoin;
    if (btc?.usd > 0) {
      const price     = btc.usd;
      const chgPct    = parseFloat((btc.usd_24h_change || 0).toFixed(2));
      const prevClose = parseFloat((price / (1 + chgPct / 100)).toFixed(2));
      pulseStore['BTC'] = { price, prevClose, chgPct, updatedAt: Date.now() };
    }
  } catch (e) { /* keep stale */ }

  console.log('[Pulse] Updated:', Object.keys(pulseStore).join(', '));
}

let pulseTimer = null;
function schedulePulse() {
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(async () => {
    await runPulseFetch();
    schedulePulse();
  }, 60_000);
}

// ─── STARTUP ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 APEX SCANNER running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server active`);
  console.log(`🔑 Data source: ${process.env.DATA_SOURCE || 'demo'}`);
  console.log(`📦 Store: wide scan pool via POOL_FILTERS, display filters applied client-side`);
  console.log(`⚡ Price refresh: 10s pre-market, 5s market open (4am–10:30am ET)\n`);

  await runScan();
  scheduleScan();

  await runPulseFetch();
  schedulePulse();

  schedulePriceRefresh();
});

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────

process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received — shutting down gracefully');
  if (scanTimer)         clearTimeout(scanTimer);
  if (priceRefreshTimer) clearTimeout(priceRefreshTimer);
  if (pulseTimer)        clearTimeout(pulseTimer);
  server.close(() => {
    console.log('[Server] HTTP server closed');
    process.exit(0);
  });
});
