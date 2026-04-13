/**
 * Alerter — throttled webhook notifications for operational events.
 *
 * Sends POST requests to a configured webhook URL when key events occur
 * (circuit breaker open, all keys exhausted). Throttles to 1 alert per
 * event type per throttle window to prevent spam.
 *
 * Bounded memory: periodic cleanup of expired dedup entries prevents unbounded growth.
 */
const https = require("https");
const http = require("http");

// Default TTLs per event type (ms). Events fire at most once per TTL window.
const DEFAULT_EVENT_TTLS = {
  circuit_open: 60000,          // 1 min — outage, fire quickly
  all_keys_exhausted: 60000,    // 1 min
  provider_error: 300000,       // 5 min — don't spam on transient errors
  budget_exceeded: 86400000,    // 24h — budget alerts once per day
  key_invalid: 3600000,         // 1h — auth failure, one alert per hour
};

const MAX_DEDUP_ENTRIES = 10000;  // Hard cap on dedup map size
const DEDUP_CLEANUP_INTERVAL = 300000; // 5 min cleanup cycle

class Alerter {
  /**
   * @param {object} opts
   * @param {string} [opts.webhookUrl]      - POST target URL (empty = disabled)
   * @param {number} [opts.throttleMs]      - Default min interval (default: 60000)
   * @param {number} [opts.timeoutMs]       - Request timeout (default: 5000)
   * @param {object} [opts.eventTtls]       - Per-event TTL overrides
   * @param {number} [opts.digestIntervalMs]- Digest flush interval (default: 0 = disabled)
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.webhookUrl = (opts.webhookUrl || "").trim();
    this.throttleMs = opts.throttleMs ?? 60000;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.logger = opts.logger || console;
    this.eventTtls = { ...DEFAULT_EVENT_TTLS, ...(opts.eventTtls || {}) };
    this._lastFired = new Map();  // dedupKey → timestamp
    this._digestBuf = [];         // buffered alerts for digest mode
    this._digestInterval = opts.digestIntervalMs || 0;
    this._digestTimer = null;
    this._suppressedCounts = new Map(); // dedupKey → count of suppressed alerts

    if (this._digestInterval > 0 && this.enabled) {
      this._digestTimer = setInterval(() => this._flushDigest(), this._digestInterval);
      if (this._digestTimer.unref) this._digestTimer.unref(); // don't keep process alive
    }

    // Periodic cleanup of expired dedup entries to prevent unbounded growth
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), DEDUP_CLEANUP_INTERVAL);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /** @returns {boolean} Whether alerting is configured. */
  get enabled() {
    return this.webhookUrl.length > 0;
  }

  /**
   * Fire an alert with dedup by (event, provider, model) tuple.
   * Respects per-event-type TTLs to prevent spam.
   * @param {string} event   - Event type (e.g., "circuit_open", "all_keys_exhausted")
   * @param {object} payload - Additional context (provider, model, message, etc.)
   */
  fire(event, payload = {}) {
    if (!this.enabled) return;

    // Dedup key: event + provider + model (if present)
    const dedupKey = `${event}:${payload.provider || ""}:${payload.model || ""}`;
    const now = Date.now();
    const last = this._lastFired.get(dedupKey) || 0;
    const ttl = this.eventTtls[event] ?? this.throttleMs;

    if (now - last < ttl) {
      // Suppressed — count for digest
      this._suppressedCounts.set(dedupKey, (this._suppressedCounts.get(dedupKey) || 0) + 1);
      return;
    }
    this._lastFired.set(dedupKey, now);

    const suppressed = this._suppressedCounts.get(dedupKey) || 0;
    this._suppressedCounts.delete(dedupKey);

    const alertPayload = {
      event,
      timestamp: new Date(now).toISOString(),
      ...payload,
    };
    if (suppressed > 0) {
      alertPayload.suppressed_count = suppressed;
    }

    if (this._digestInterval > 0) {
      // Buffer for digest
      this._digestBuf.push(alertPayload);
    } else {
      // Immediate send
      const body = JSON.stringify(alertPayload);
      this._send(body).catch(err => {
        this.logger.error(`[ffai:alerter] webhook failed: ${err.message}`);
      });
    }
  }

  /**
   * Flush buffered digest alerts as a single batch webhook.
   */
  _flushDigest() {
    if (this._digestBuf.length === 0) return;
    const alerts = this._digestBuf.splice(0);
    const body = JSON.stringify({
      type: "digest",
      count: alerts.length,
      timestamp: new Date().toISOString(),
      alerts,
    });
    this._send(body).catch(err => {
      this.logger.error(`[ffai:alerter] digest webhook failed: ${err.message}`);
    });
  }

  /**
   * Remove expired dedup entries and enforce hard cap.
   * Called periodically to prevent unbounded memory growth.
   */
  _cleanupExpired() {
    const now = Date.now();

    // Remove entries whose per-event TTL has expired (safe to re-fire)
    for (const [dedupKey, ts] of this._lastFired) {
      // Extract event type from dedupKey (format: "event:provider:model")
      const eventType = dedupKey.split(":")[0];
      const ttl = this.eventTtls[eventType] ?? this.throttleMs;
      if (now - ts > ttl * 2) {
        this._lastFired.delete(dedupKey);
        this._suppressedCounts.delete(dedupKey);
      }
    }

    // Clean orphaned suppressed counts (no matching lastFired entry)
    for (const key of this._suppressedCounts.keys()) {
      if (!this._lastFired.has(key)) {
        this._suppressedCounts.delete(key);
      }
    }

    // Hard cap: FIFO eviction if still over limit
    if (this._lastFired.size > MAX_DEDUP_ENTRIES) {
      const excess = this._lastFired.size - MAX_DEDUP_ENTRIES;
      let evicted = 0;
      for (const key of this._lastFired.keys()) {
        if (evicted >= excess) break;
        this._lastFired.delete(key);
        this._suppressedCounts.delete(key);
        evicted++;
      }
    }
  }

  /** Stop timers (for graceful shutdown). */
  destroy() {
    if (this._digestTimer) {
      clearInterval(this._digestTimer);
      this._digestTimer = null;
    }
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    // Flush remaining
    this._flushDigest();
  }

  /** Current number of tracked dedup keys. */
  get dedupSize() {
    return this._lastFired.size;
  }

  /**
   * Send the webhook POST request.
   * @param {string} body - JSON string
   * @returns {Promise<void>}
   */
  _send(body) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(this.webhookUrl);
      } catch {
        return reject(new Error(`invalid webhook URL: ${this.webhookUrl}`));
      }

      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "user-agent": "ffai-alerter/1.0",
        },
        timeout: this.timeoutMs,
      }, (res) => {
        res.resume(); // drain
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`webhook returned ${res.statusCode}`));
        }
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("webhook timeout")));
      req.write(body);
      req.end();
    });
  }
}

module.exports = Alerter;
