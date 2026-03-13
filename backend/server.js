/**
 * APEX SCANNER — Backend Server
 * Node.js + Express + WebSocket
 */

const express    = require('express');
const axios      = require('axios');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const scannerRoutes = require('./routes/scanner');
const newsRoutes    = require('./routes/news');
const alertRoutes   = require('./routes/alerts');
process.env.DATA_SOURCE = 'polygon';
const { ScannerService } = require('./services/scanner');
const { NewsService }    = require('./services/news');
const { CacheService }   = require('./services/cache');
const store              = require('./services/store');

require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── MIDDLEWARE ──────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// ─── SERVICES ────────────────────────────────────────────────
const cache   = new CacheService();
const news    = new NewsService({ cache, apiKey: process.env.NEWS_API_KEY });
const scanner = new ScannerService({ cache, news });

app.locals.scanner = scanner;
app.locals.news    = news;
app.locals.cache   = cache;
app.locals.wss     = wss;
app.locals.store   = store;

// ─── ROUTES ──────────────────────────────────────────────────
app.use('/api/scanner', scannerRoutes);
app.use('/api/news',    newsRoutes);
app.use('/api/alerts',  alertRoutes);
app.use('/api/pulse',   require('./routes/pulse'));

// Serve cached pulse data — instant, no Polygon call needed
app.get('/api/pulse/all', (req, res) => {
  res.json(pulseStore);
});

app.get('/api/health', (req, res) => {
  res.json({
    status:     'ok',
    uptime:     process.uptime(),
    timestamp:  new Date().toISOString(),
    dataSource: process.env.DATA_SOURCE || 'demo',
    store:      store.stats(),
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── WEBSOCKET ───────────────────────────────────────────────
const wsClients = new Map();

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).slice(2);
  wsClients.set(clientId, { ws, filters: {} });
  console.log(`[WS] Client connected: ${clientId} (total: ${wsClients.size})`);
  ws.send(JSON.stringify({ type: 'connected', clientId }));

  // Send latest store pool immediately on connect
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
      if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch (e) {
      console.warn('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', () => { wsClients.delete(clientId); });
  ws.on('error', (err) => { console.error('[WS] Error:', err.message); wsClients.delete(clientId); });
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  let sent = 0;
  wsClients.forEach(({ ws }, clientId) => {
    if (ws.readyState === WebSocket.OPEN) { ws.send(msg); sent++; }
    else wsClients.delete(clientId);
  });
  return sent;
}
app.locals.broadcast = broadcast;

// ─── WIDE SCAN FILTERS ───────────────────────────────────────
// Backend always scans wide — frontend filters the pool
const WIDE_FILTERS = {
  priceMin:     0.50,
  priceMax:     25.00,
  gapMin:       0,
  floatMax:     500000000,
  dollarVolMin: 0,
  floatRotMin:  0,
  volMin:       0,
  rvolMin:      0,
  excludeEtf:   true,
};

// ─── SCAN SCHEDULER ──────────────────────────────────────────
function getMarketSession() {
  const now  = new Date();
  const etH  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etM  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  const mins = etH * 60 + etM;
  if (mins >= 240 && mins < 570)  return 'premarket';
  if (mins >= 570 && mins < 960)  return 'regular';
  if (mins >= 960 && mins < 1200) return 'afterhours';
  return 'closed';
}

let scanRunning = false;

async function runScan() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const session = getMarketSession();

    // Skip scan during closed hours — store stays stale, frontend shows last results
    if (session === 'closed') {
      console.log('[Scan] Market closed — skipping scan');
      scanRunning = false;
      return;
    }

    const results = await scanner.scan(WIDE_FILTERS);

    if (results && results.length > 0 && !results[0].ticker?.startsWith('DEMO')) {
      store.set(results, session);
      broadcast('scan_results', results);

      // Alert broadcasts
      const alerts = results.filter(s => s.breakingPmh || s.volumeSpike || s.newSetup);
      if (alerts.length > 0) {
        broadcast('alerts', alerts.map(s => ({
          ticker:  s.ticker,
          type:    s.breakingPmh ? 'pmh' : s.volumeSpike ? 'vspike' : 'new',
          price:   s.price,
          message: s.breakingPmh ? `Breaking PM High $${s.pmHigh?.toFixed(2)}`
                 : s.volumeSpike ? `Vol Spike`
                 : `New setup — Gap ${s.gapPct?.toFixed(1)}%`,
        })));
      }
    }
  } catch (err) {
    console.error('[Scan] Error:', err.message);
  }
  scanRunning = false;
}

function getRefreshInterval() {
  const now  = new Date();
  const etH  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etM  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  const mins = etH * 60 + etM;
  if (mins >= 240 && mins < 570)  return 60000;  // Pre-market:  60s
  if (mins >= 570 && mins < 960)  return 30000;  // Market open: 30s
  if (mins >= 960 && mins < 1200) return 120000; // After hours: 2min
  return null; // Closed: don't schedule
}

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  const interval = getRefreshInterval();
  if (!interval) {
    console.log('[Scheduler] Market closed — scan paused until pre-market');
    // Check again in 10 minutes in case we cross into pre-market
    scanTimer = setTimeout(scheduleScan, 600000);
    return;
  }
  scanTimer = setTimeout(async () => {
    await runScan();
    scheduleScan();
  }, interval);
}

// ─── PULSE SCHEDULER ────────────────────────────────────────
const PULSE_SYMBOLS = [
  { sym: 'SPY',  poly: 'SPY'      },
  { sym: 'QQQ',  poly: 'QQQ'      },
  { sym: 'IWM',  poly: 'IWM'      },
  { sym: 'VIX',  poly: 'I:VIX'   },
  { sym: 'XBI',  poly: 'XBI'      },
  { sym: 'BTC',  poly: 'X:BTCUSD' },
];

const pulseStore = {};  // sym -> { price, prevClose, chgPct, session, updatedAt }

async function runPulseFetch() {
  const apiKey = process.env.POLYGON_API_KEY || '';
  if (!apiKey) return;
  for (const { sym, poly } of PULSE_SYMBOLS) {
    try {
      let url;
      if (poly.startsWith('X:'))
        url = `https://api.polygon.io/v2/snapshot/locale/global/markets/crypto/tickers/${poly}?apiKey=${apiKey}`;
      else if (poly.startsWith('I:'))
        url = `https://api.polygon.io/v2/snapshot/locale/us/markets/indices/tickers/${poly}?apiKey=${apiKey}`;
      else
        url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${poly}?apiKey=${apiKey}`;

      const res = await axios.get(url, { timeout: 8000 });
      const t   = res.data?.ticker || {};
      const day  = t.day     || {};
      const prev = t.prevDay || {};

      let price = t.lastTrade?.p || t.lastQuote?.P || day.c || prev.c || 0;
      if (poly.startsWith('X:')) price = t.lastTrade?.p || day.c || prev.c || 0;
      if (poly.startsWith('I:')) price = t.value || day.c || 0;

      const prevClose = prev.c || 0;
      const chgPct    = t.todaysChangePerc !== undefined
        ? t.todaysChangePerc
        : prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

      if (price > 0) {
        pulseStore[sym] = {
          price:     parseFloat(price.toFixed(2)),
          prevClose: parseFloat(prevClose.toFixed(2)),
          chgPct:    parseFloat(chgPct.toFixed(2)),
          updatedAt: Date.now(),
        };
      }
    } catch(e) {
      // keep stale value on error
    }
    await new Promise(r => setTimeout(r, 300)); // stagger requests
  }
  console.log('[Pulse] Updated:', Object.keys(pulseStore).join(', '));
}

let pulseTimer = null;
function schedulePulse() {
  if (pulseTimer) clearTimeout(pulseTimer);
  pulseTimer = setTimeout(async () => {
    await runPulseFetch();
    schedulePulse();
  }, 60000); // refresh every 60s
}

// ─── STARTUP ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 APEX SCANNER running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server active`);
  console.log(`🔑 Data source: ${process.env.DATA_SOURCE || 'demo'}`);
  console.log(`📦 Store: wide scan pool, filters applied at read time`);
  console.log(`\nPress Ctrl+C to stop\n`);

  await runScan();
  scheduleScan();
  await runPulseFetch();
  schedulePulse();
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  if (scanTimer) clearTimeout(scanTimer);
  server.close(() => process.exit(0));
});
