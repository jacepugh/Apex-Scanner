Apex Scanner
A full-stack, real-time stock scanner and trade execution platform built for gap-up momentum trading. Scans the entire market pre-market, scores setups, and supports paper/live trade execution with automated bracket orders.
Live app: https://apex-scanner-production.up.railway.app
Overview
Apex Scanner identifies low-float, high-relative-volume gap-up setups in real time and gives traders the tools to size positions, track catalysts, and execute trades — all from a mobile-first interface designed for pre-market speed (4:00–9:30am ET).
Backtested performance: 54% win rate, 1.85 profit factor. Currently paper trading live with a 62.8% win rate and 1.89 profit factor across ~43 trades.
Features
Real-time market scanning — full-market snapshot scans (/v2/snapshot) surfacing the top 50 candidates by gap %, relative volume, and float
Catalyst classification — automatically tags stocks with news-driven catalysts (FDA approvals, earnings beats, M&A, contract wins, partnerships, SEC filings)
Position sizing tool — risk-based sizer calculating share count, position size, max risk, and 2R targets, with built-in guardrails against oversized or overleveraged trades
Live charting — canvas-rendered charts with Gap & Go pattern overlays, powered by Alpaca bar data
Automated execution layer — Alpaca-integrated bracket orders with scaled exits (25/25/50), breakeven stop logic, and a paper/live trading toggle
Security-hardened — JWT auth via httpOnly cookies, CSRF protection, AES-256-GCM encrypted trade journal, WebAuthn fingerprint login
Resilient data pipeline — automatic fallback chain across three market data providers (Polygon → Finnhub → Alpha Vantage) with WebSocket streaming and HTTP polling fallback
Tech Stack
Backend: Node.js, Express
Frontend: Vanilla HTML/CSS/JS (single-page, mobile-first)
Data: Polygon.io (real-time), Finnhub, Alpha Vantage
Execution: Alpaca Trading API
Auth/Security: JWT, CSRF tokens, WebAuthn, AES-256-GCM
Hosting: Railway
Architecture
Code
Strategy
Built around a gap-up momentum approach targeting:
Small/micro-cap stocks, low float (<20M shares)
Relative volume 5x+, gap 5%+
Price range $0.50–$25
Pre-market volume 500K+
Preference for stocks with a news catalyst
Status
Actively developed, core scanning, scoring, charting, and execution phases are complete. Currently focused on refining strategy performance through live paper trading and studying position sizing, ORB strategy, and Level 2 order flow.
Built as a solo full-stack project from market data pipeline to trade execution with the help of Claude code. 
