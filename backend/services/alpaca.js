'use strict';

/**
 * alpaca.js
 * Fetches OHLCV bars from Alpaca Markets Data API v2.
 * Supports 1Min and 5Min timeframes.
 * Uses ALPACA_API_KEY + ALPACA_SECRET_KEY env vars.
 * SIP feed — full pre-market coverage for all listed tickers.
 */

const axios = require('axios');

const BASE_URL     = 'https://data.alpaca.markets/v2';
const VALID_FRAMES = new Set(['1Min', '5Min']);
const FRAME_LIMITS = { '1Min': 500, '5Min': 120 };

class AlpacaService {
  constructor() {
    this.apiKey      = process.env.ALPACA_API_KEY    || '';
    this.secretKey   = process.env.ALPACA_SECRET_KEY || '';
    this._warnedOnce = false;
  }

  _headers() {
    return {
      'APCA-API-KEY-ID':     this.apiKey,
      'APCA-API-SECRET-KEY': this.secretKey,
    };
  }

  _isConfigured() {
    return Boolean(this.apiKey && this.secretKey);
  }

  // Returns true if currently in EDT (UTC-4), false for EST (UTC-5)
  _isDst() {
    const now = new Date();
    const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
    const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
    return now.getTimezoneOffset() < Math.max(jan, jul);
  }

  _etOffsetHours() {
    return this._isDst() ? -4 : -5;
  }

  // Returns 4:00am ET today as UTC ISO string.
  // Pure UTC math — no locale string parsing, works on Railway Linux.
  _todayPremarketStart() {
    const now        = new Date();
    const offsetMs   = this._etOffsetHours() * 3600 * 1000;

    // Shift now into ET to get the correct ET calendar date
    const etNow = new Date(now.getTime() + offsetMs);
    const y     = etNow.getUTCFullYear();
    const mo    = String(etNow.getUTCMonth() + 1).padStart(2, '0');
    const d     = String(etNow.getUTCDate()).padStart(2, '0');

    // Build 4am ET as a UTC timestamp by subtracting the ET offset
    const fourAmEt = new Date(`${y}-${mo}-${d}T04:00:00.000Z`);
    fourAmEt.setTime(fourAmEt.getTime() - offsetMs);

    return fourAmEt.toISOString();
  }

  /**
   * Fetch OHLCV bars for a ticker.
   * @param {string} ticker    — uppercase symbol e.g. 'AAPL'
   * @param {string} timeframe — '1Min' (default) or '5Min'
   * @returns {Promise<Array>} bars: [{ t, o, h, l, c, v }, ...]
   */
  async getBars(ticker, timeframe = '1Min') {
    if (!this._isConfigured()) {
      if (!this._warnedOnce) {
        console.warn('[Alpaca] Keys not set — chart data unavailable');
        this._warnedOnce = true;
      }
      return [];
    }

    const tf    = VALID_FRAMES.has(timeframe) ? timeframe : '1Min';
    const start = this._todayPremarketStart();
    console.log(`[Alpaca] Fetching ${ticker} ${tf} from ${start}`);

    try {
      const res = await axios.get(
        `${BASE_URL}/stocks/${encodeURIComponent(ticker)}/bars`,
        {
          headers: this._headers(),
          params: {
            timeframe:  tf,
            start,
            limit:      FRAME_LIMITS[tf],
            feed:       'sip',
            adjustment: 'raw',
          },
          timeout: 10_000,
        }
      );

      const bars = res.data?.bars || [];
      console.log(`[Alpaca] ${ticker} ${tf}: ${bars.length} bars`);
      return bars;

    } catch (err) {
      if (err.response?.status === 422 || err.response?.status === 404) {
        console.warn(`[Alpaca] ${ticker}: no bars (${err.response.status})`);
        return [];
      }
      console.error(`[Alpaca] ${ticker}:`, err.response?.data?.message || err.message);
      return [];
    }
  }
}

const alpaca = new AlpacaService();
module.exports = { alpaca, AlpacaService };
