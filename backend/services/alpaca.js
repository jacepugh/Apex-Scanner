'use strict';

/**
 * AlpacaService
 * Fetches OHLCV bars from Alpaca Markets Data API v2.
 * Supports 1Min and 5Min timeframes.
 * Uses ALPACA_API_KEY + ALPACA_SECRET_KEY env vars.
 * IEX feed — free with any Alpaca account, no SIP needed.
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

  // Returns 4:00am ET today as ISO-8601 with ET offset.
  _todayPremarketStart() {
    const now    = new Date();
    const etStr  = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const etDate = new Date(etStr);
    const y      = etDate.getFullYear();
    const mo     = String(etDate.getMonth() + 1).padStart(2, '0');
    const d      = String(etDate.getDate()).padStart(2, '0');
    return `${y}-${mo}-${d}T04:00:00-04:00`;
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

    const tf = VALID_FRAMES.has(timeframe) ? timeframe : '1Min';

    try {
      const res = await axios.get(
        `${BASE_URL}/stocks/${encodeURIComponent(ticker)}/bars`,
        {
          headers: this._headers(),
          params: {
            timeframe:  tf,
            start:      this._todayPremarketStart(),
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
