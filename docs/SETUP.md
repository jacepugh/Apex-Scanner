# APEX SCANNER — Complete Setup & Deployment Guide

## What You Have

```
apex-scanner/
├── frontend/
│   └── index.html          ← Complete scanner UI (works standalone in browser)
├── backend/
│   ├── server.js           ← Express + WebSocket server
│   ├── routes/
│   │   ├── scanner.js      ← GET /api/scanner
│   │   ├── news.js         ← GET /api/news/:ticker
│   │   └── alerts.js       ← GET/POST /api/alerts
│   └── services/
│       ├── scanner.js      ← Core scan engine (Polygon/Finnhub/AV)
│       ├── news.js         ← News fetch + catalyst classifier
│       └── cache.js        ← In-memory + Redis cache
├── .env.example            ← Copy to .env with your keys
├── package.json
└── docs/
    └── SETUP.md            ← This file
```

---

## Quick Start (Demo Mode — No API Key Needed)

```bash
# 1. Open frontend/index.html directly in your browser
#    Works immediately with realistic mock data, live price simulation,
#    alerts, filtering, presets — everything functional.

open frontend/index.html
```

---

## Full Backend Setup

### Prerequisites
- Node.js ≥ 18 (https://nodejs.org)
- npm (comes with Node)

### Install & Run

```bash
# Clone / download the project
cd apex-scanner

# Install dependencies
npm install

# Copy env file and add your API key
cp .env.example .env
# Edit .env: set DATA_SOURCE and your API key

# Start server
npm start

# Development mode (auto-restart on file changes)
npm run dev

# Open browser
open http://localhost:3000
```

---

## API Key Setup

### Option 1: Polygon.io (RECOMMENDED)
**Best for production.** Most comprehensive US equity data.

1. Sign up at https://polygon.io
2. Free tier: 5 calls/min (okay for testing)
3. Starter ($29/mo): Unlimited calls, real-time data
4. In `.env`:
   ```
   DATA_SOURCE=polygon
   POLYGON_API_KEY=your_key_here
   ```

**What Polygon provides:**
- Real-time + snapshot data for all US equities
- Pre-market OHLCV
- Relative volume (via prev day avg)
- Float/shares outstanding (via ticker details endpoint)
- News articles
- Options for WebSocket streaming (upgrade plan)

### Option 2: Finnhub
**Good free tier.** 60 req/min free.

1. Sign up at https://finnhub.io
2. Free: 60 calls/min
3. In `.env`:
   ```
   DATA_SOURCE=finnhub
   FINNHUB_API_KEY=your_key_here
   ```

**Limitation:** No built-in relative volume. Float data less reliable.

### Option 3: Alpha Vantage
**Most limited.** Only recommended for light testing.

1. Sign up at https://www.alphavantage.co/support/#api-key
2. Free: 5 calls/min, 500/day
3. In `.env`:
   ```
   DATA_SOURCE=alphaVantage
   ALPHA_VANTAGE_API_KEY=your_key_here
   ```

---

## Getting Float Data

Float data is the hardest to get cheaply. Options:

| Source | Cost | Quality |
|--------|------|---------|
| Polygon.io Ticker Details | Included in plan | Good |
| Finviz Elite | $40/mo | Excellent |
| IEX Cloud | $9/mo+ | Good |
| Benzinga Pro | $99/mo | Excellent + news |
| Manual Finviz screener | Free | Manual only |

**Workaround:** Cache float data. Float rarely changes — you can fetch it once
per ticker per day and reuse. The cache service handles this automatically.

---

## Deploying to Production

### Option A: Railway (Easiest, ~$5/mo)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway init

# Deploy
railway up

# Set environment variables in Railway dashboard
# Or via CLI:
railway variables set DATA_SOURCE=polygon
railway variables set POLYGON_API_KEY=your_key
```

Railway auto-detects Node.js and runs `npm start`.

### Option B: Render (Free tier available)

1. Push code to GitHub
2. Go to https://render.com → New Web Service
3. Connect GitHub repo
4. Build command: `npm install`
5. Start command: `npm start`
6. Add environment variables in Render dashboard
7. Free tier sleeps after 15min inactivity — use paid ($7/mo) for trading hours

### Option C: Vercel (Frontend only — serverless)

Vercel works for the frontend only. For backend + WebSockets, use Railway or Render.

```bash
npm install -g vercel
cd frontend
vercel
```

### Option D: AWS EC2 (Most control)

```bash
# Launch EC2 t3.small or larger
# SSH in, then:
sudo apt update && sudo apt install nodejs npm git -y
git clone your-repo
cd apex-scanner
npm install
cp .env.example .env && nano .env

# Install PM2 for process management
npm install -g pm2
pm2 start backend/server.js --name apex-scanner
pm2 startup  # auto-restart on reboot
pm2 save
```

---

## Adding Redis (Optional, for speed)

```bash
# Local Redis (Mac)
brew install redis
brew services start redis

# Local Redis (Ubuntu)
sudo apt install redis-server
sudo systemctl start redis

# In .env:
REDIS_URL=redis://localhost:6379
```

For Railway managed Redis:
- Railway dashboard → + New → Redis → connect to your app

---

## WebSocket Integration (Frontend)

The frontend connects to the backend WebSocket automatically when running
on the full stack. The UI updates in real time when the server pushes scan results.

```javascript
// The frontend auto-connects to:
// ws://localhost:3000  (local)
// wss://yourdomain.com (production)

// Message types sent by server:
// { type: 'scan_results', data: [...stocks] }
// { type: 'alerts', data: [...alerts] }
// { type: 'connected', clientId: '...' }

// To send filter updates from frontend:
ws.send(JSON.stringify({
  type: 'set_filters',
  filters: { priceMin: 1, priceMax: 20, rvolMin: 5 }
}));
```

---

## Future Upgrades (Architecture is Ready)

The codebase is structured to support:

1. **AI Catalyst Scoring** — Add OpenAI/Claude API call in `news.js classifyArticle()`
   to score headline sentiment and specificity 1–10

2. **Dilution Risk Detection** — Check SEC EDGAR for recent S-1/ATM filings in `scanner.js`

3. **Pattern Recognition** — Add ORB detection, VWAP reclaim, SFP patterns
   by computing from 1-min OHLCV data (Polygon free tier includes this)

4. **Backtesting Module** — The backtest apps you already have can be integrated
   as a `/backtest` route using the same filter presets

5. **SMS Alerts via Twilio** — In `routes/alerts.js`, add:
   ```javascript
   const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
   await twilio.messages.create({
     body: `APEX ALERT: ${ticker} ${type} — ${message}`,
     from: process.env.TWILIO_FROM,
     to: process.env.ALERT_PHONE,
   });
   ```

6. **PostgreSQL Persistence** — Replace `alertHistory` array in `routes/alerts.js`
   with a Postgres table for persistent alert logging and performance analytics

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scanner` | GET | Run scan with filter params |
| `/api/scanner/ticker/:symbol` | GET | Single ticker news + data |
| `/api/scanner/status` | GET | Cache + scan status |
| `/api/news/:ticker` | GET | News for ticker |
| `/api/alerts` | GET | Alert history |
| `/api/alerts` | POST | Log alert |
| `/api/health` | GET | Server health check |

### Scanner Query Params
```
GET /api/scanner?priceMin=1&priceMax=20&volMin=2000000&rvolMin=5&gapMin=8&floatMax=20000000&catalyst=true
```

---

## Recommended Data Stack for $50-100/month

| Service | Cost | Purpose |
|---------|------|---------|
| Polygon.io Starter | $29/mo | Market data, news, float |
| Railway | $5/mo | Hosting + managed Redis |
| Benzinga Pro | $99/mo | Premium news + catalyst detection |
| **Total** | **~$133/mo** | Full production stack |

Or minimal viable:
| Finnhub Free | $0 | Market data (rate limited) |
| Render free tier | $0 | Hosting (sleeps when idle) |
| **Total** | **$0** | Testing only |
