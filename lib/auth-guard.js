/**
 * AuthGuard — per-IP brute-force protection for API auth.
 *
 * Tracks failed auth attempts per IP with sliding windows.
 * Blocks IPs that exceed the failure threshold.
 * Stale-first eviction prevents unbounded memory growth.
 *
 * Production-hardened auth with sliding-window IP blocking.
 */
const crypto = require("crypto");

class AuthGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.failWindow]      - Window for counting failures (ms, default: 60000)
   * @param {number} [opts.failMax]         - Max failures per window before block (default: 10)
   * @param {number} [opts.blockDuration]   - Block duration after exceeding (ms, default: 300000)
   * @param {number} [opts.maxEntries]      - Size cap for tracking map (default: 100000)
   * @param {number} [opts.cleanupInterval] - Stale entry cleanup interval (ms, default: 300000)
   */
  constructor(opts = {}) {
    this.failWindow = opts.failWindow ?? 60000;
    this.failMax = opts.failMax ?? 10;
    this.blockDuration = opts.blockDuration ?? 300000;
    this.maxEntries = opts.maxEntries ?? 100000;
    this._entries = new Map(); // ip → { count, windowStart, blockedUntil }

    // Periodic cleanup of stale entries
    this._cleanupInterval = opts.cleanupInterval ?? 300000;
    if (this._cleanupInterval > 0) {
      this._timer = setInterval(() => this._cleanup(), this._cleanupInterval);
      this._timer.unref();
    }
  }

  /**
   * Check if an IP is currently blocked.
   * @param {string} ip
   * @returns {boolean}
   */
  isBlocked(ip) {
    const entry = this._entries.get(ip);
    if (!entry) return false;
    const now = Date.now();
    if (entry.blockedUntil && now < entry.blockedUntil) return true;
    if (entry.blockedUntil && now >= entry.blockedUntil) {
      this._entries.delete(ip);
      return false;
    }
    return false;
  }

  /**
   * Record an auth failure for an IP.
   * @param {string} ip
   */
  recordFailure(ip) {
    const now = Date.now();
    let entry = this._entries.get(ip);
    if (!entry || (now - entry.windowStart) > this.failWindow) {
      entry = { count: 0, windowStart: now, blockedUntil: 0 };
    }
    entry.count++;
    if (entry.count >= this.failMax) {
      entry.blockedUntil = now + this.blockDuration;
    }
    this._entries.set(ip, entry);
    this._evictIfNeeded();
  }

  /**
   * Timing-safe comparison of auth token.
   * @param {string} provided  - Value from Authorization header
   * @param {string} expected  - Expected "Bearer <key>" string
   * @returns {boolean}
   */
  static timingSafeCheck(provided, expected) {
    // Fix #10: Hash both sides to eliminate length oracle.
    // timingSafeEqual requires equal lengths — hashing ensures this
    // while preventing attackers from learning the expected key length.
    const aHash = crypto.createHmac("sha256", "ffai-auth").update(provided).digest();
    const bHash = crypto.createHmac("sha256", "ffai-auth").update(expected).digest();
    return crypto.timingSafeEqual(aHash, bHash);
  }

  /**
   * Check Bearer auth from request headers.
   * @param {object} headers - Request headers object
   * @param {string} requiredKey - Expected key value (without "Bearer " prefix)
   * @returns {boolean}
   */
  checkAuth(headers, requiredKey) {
    if (!requiredKey) return true;
    const auth = headers["authorization"] || headers["Authorization"] || "";
    return AuthGuard.timingSafeCheck(auth, `Bearer ${requiredKey}`);
  }

  _evictIfNeeded() {
    if (this._entries.size <= this.maxEntries) return;
    const now = Date.now();
    let evicted = 0;
    // First pass: remove expired blocks and stale windows
    for (const [ip, e] of this._entries) {
      if (evicted >= 1000) break;
      if ((e.blockedUntil && now >= e.blockedUntil) ||
          (now - e.windowStart > this.failWindow * 2)) {
        this._entries.delete(ip);
        evicted++;
      }
    }
    // FIFO fallback if still over limit
    if (evicted === 0) {
      const iter = this._entries.keys();
      for (let i = 0; i < 1000; i++) {
        const key = iter.next().value;
        if (key === undefined) break;
        this._entries.delete(key);
      }
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [ip, entry] of this._entries) {
      if (entry.blockedUntil && now >= entry.blockedUntil) {
        this._entries.delete(ip);
      } else if ((now - entry.windowStart) > this.failWindow * 2) {
        this._entries.delete(ip);
      }
    }
  }

  /** Stop the periodic cleanup timer. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = AuthGuard;
