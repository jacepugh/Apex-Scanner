/**
 * CacheService
 * In-memory LRU cache with optional Redis backend.
 * Falls back gracefully to in-memory if Redis unavailable.
 */

class CacheService {
  constructor() {
    this.store = new Map();
    this.ttls  = new Map();
    this.redis = null;
    this.useRedis = false;

    // Try Redis if configured
    if (process.env.REDIS_URL) {
      this.initRedis();
    }

    // Cleanup expired entries every 60s
    setInterval(() => this.cleanup(), 60000);
  }

  async initRedis() {
    try {
      const { createClient } = require('redis');
      this.redis = createClient({ url: process.env.REDIS_URL });
      await this.redis.connect();
      this.useRedis = true;
      console.log('[Cache] Redis connected');
    } catch (err) {
      console.warn('[Cache] Redis unavailable, using in-memory cache:', err.message);
      this.useRedis = false;
    }
  }

  // GET
  get(key) {
    if (this.useRedis) {
      // Redis is async — for sync usage, fall back to in-memory mirror
      return this._memGet(key);
    }
    return this._memGet(key);
  }

  // Async GET (use for Redis)
  async getAsync(key) {
    if (this.useRedis) {
      try {
        const val = await this.redis.get(key);
        return val ? JSON.parse(val) : null;
      } catch { return this._memGet(key); }
    }
    return this._memGet(key);
  }

  _memGet(key) {
    const expiry = this.ttls.get(key);
    if (expiry && Date.now() > expiry) {
      this.store.delete(key);
      this.ttls.delete(key);
      return undefined;
    }
    return this.store.has(key) ? this.store.get(key) : undefined;
  }

  // SET (ttlSeconds default = 30)
  set(key, value, ttlSeconds = 30) {
    this.store.set(key, value);
    this.ttls.set(key, Date.now() + ttlSeconds * 1000);

    if (this.useRedis) {
      this.redis.setEx(key, ttlSeconds, JSON.stringify(value)).catch(() => {});
    }
  }

  // DELETE
  delete(key) {
    this.store.delete(key);
    this.ttls.delete(key);
    if (this.useRedis) this.redis.del(key).catch(() => {});
  }

  // CLEANUP expired entries
  cleanup() {
    const now = Date.now();
    for (const [key, expiry] of this.ttls) {
      if (now > expiry) {
        this.store.delete(key);
        this.ttls.delete(key);
      }
    }
  }

  // STATS
  stats() {
    return {
      keys: this.store.size,
      redis: this.useRedis,
    };
  }
}

module.exports = { CacheService };
