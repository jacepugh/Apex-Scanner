/**
 * APEX SCANNER — Backend Server
 * Node.js + Express + WebSocket
 * 
 * Install: npm install
 * Run:     npm start
 * Dev:     npm run dev
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const cron       = require('node-cron');

const scannerRoutes = require('./routes/scanner');
const newsRoutes    = require('./routes/news');
const alertRoutes   = require('./routes/alerts');
process.env.DATA_SOURCE = 'polygon';
const { ScannerService } = require('./services/scanner');
const { NewsService }    = require('./services/news');
const { CacheService }   = require('./services/cache');

require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ─── MIDDLEWARE ────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', limiter);

// ─── SERVICES ─────────────────────────────────────────────────
const cache   = new CacheService();
const news    = new NewsService({ cache, apiKey: process.env.NEWS_API_KEY });
const scanner = new ScannerService({ cache, news });

// Make services available to routes
app.locals.scanner = scanner;
app.locals.news    = news;
app.locals.cache   = cache;
app.locals.wss     = wss;

// ─── ROUTES ───────────────────────────────────────────────────
app.use('/api/scanner', scannerRoutes);
app.use('/api/news',    newsRoutes);
app.use('/api/alerts',  alertRoutes);
app.use('/api/pulse', require('./routes/pulse'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dataSource: process.env.DATA_SOURCE || 'demo',
  });
});

// Serve frontend for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── WEBSOCKET ────────────────────────────────────────────────
const wsClients = new Map(); // clientId → { ws, filters }

wss.on('connection', (ws, req) => {
  const clientId = Math.random().toString(36).slice(2);
  wsClients.set(clientId, { ws, filters: {} });
  console.log(`[WS] Client connected: ${clientId} (total: ${wsClients.size})`);

  ws.send(JSON.stringify({ type: 'connected', clientId }));

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

  ws.on('close', () => {
    wsClients.delete(clientId);
    console.log(`[WS] Client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    wsClients.delete(clientId);
  });
});

// Broadcast scan results to all connected clients
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, timestamp: Date.now() });
  let sent = 0;
  wsClients.forEach(({ ws, filters }, clientId) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
      sent++;
    } else {
      wsClients.delete(clientId);
    }
  });
  return sent;
}

app.locals.broadcast = broadcast;

// ─── SCAN SCHEDULER ───────────────────────────────────────────
// Pre-market scan: every 15s from 4:00–9:30 ET
// Market hours scan: every 10s from 9:30–16:00 ET
// After-hours: every 30s

let scanRunning = false;

async function runScan() {
  if (scanRunning) return;
  scanRunning = true;
  try {
    const results = await scanner.scan();
    if (results.length > 0) {
      broadcast('scan_results', results);
      
      // Check for breakout alerts
      const alerts = results.filter(s => s.breakingPmh || s.volumeSpike || s.newSetup);
      if (alerts.length > 0) {
        broadcast('alerts', alerts.map(s => ({
          ticker: s.ticker,
          type: s.breakingPmh ? 'pmh' : s.volumeSpike ? 'vspike' : 'new-ticker',
          price: s.price,
          message: s.breakingPmh ? `Breaking PM High $${s.pmHigh?.toFixed(2)}`
                 : s.volumeSpike ? `Vol Spike ${s.rvol?.toFixed(1)}×`
                 : `New setup — Gap ${s.gapPct?.toFixed(1)}%`,
        })));
      }
    }
  } catch (err) {
    console.error('[Scan] Error:', err.message);
  }
  scanRunning = false;
}

// Schedule based on market hours (ET)
function getRefreshInterval() {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etMin  = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
  const mins = etHour * 60 + etMin;
  if (mins >= 240 && mins < 570)  return 15000; // Pre-market: 15s
  if (mins >= 570 && mins < 960)  return 10000; // Market: 10s
  if (mins >= 960 && mins < 1200) return 30000; // AH: 30s
  return 60000; // Closed: 60s
}

let scanTimer = null;
function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  const interval = getRefreshInterval();
  scanTimer = setTimeout(async () => {
    await runScan();
    scheduleScan(); // adaptive reschedule
  }, interval);
}

// ─── STARTUP ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`\n🚀 APEX SCANNER running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket server active`);
  console.log(`🔑 Data source: ${process.env.DATA_SOURCE || 'demo'}`);
  console.log(`\nPress Ctrl+C to stop\n`);

  // Initial scan
  await runScan();
  scheduleScan();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
});
