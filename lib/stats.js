/**
 * Stats — persistent statistics tracking with atomic flush.
 *
 * Tracks per-provider, per-day, per-key request/error/rate-limit counts.
 * Uses dirty-flag batched flushing with atomic temp-file writes.
 */
const fs = require("fs");
const path = require("path");
const { todayKey } = require("./utils");

class Stats {
  /**
   * @param {object} opts
   * @param {string} opts.file            - Path to stats.json
   * @param {number} [opts.flushInterval] - Flush interval ms (default: 60000)
   * @param {number} [opts.retentionDays] - Days to retain (default: 7)
   */
  constructor(opts) {
    this.file = opts.file;
    this.flushInterval = opts.flushInterval ?? 60000;
    this.retentionDays = opts.retentionDays ?? 7;
    this._dirty = false;
    this._flushing = false;
    this._timer = null;

    // Load existing stats
    this.data = this._load();

    // Start periodic flush
    if (this.flushInterval > 0) {
      this._timer = setInterval(() => this.flush(), this.flushInterval);
      this._timer.unref();
    }
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.startedAt || !parsed.days || typeof parsed.days !== "object") {
        throw new Error("invalid stats format");
      }
      return parsed;
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`[ffai:stats] stats file corrupt, starting fresh: ${err.message}`);
      }
      return { startedAt: Date.now(), days: {} };
    }
  }

  /**
   * Get or create today's stats bucket for a provider.
   * @param {string} providerName
   * @param {function} [emptyDayFn] - Factory for empty day stats
   * @returns {object}
   */
  getProviderDay(providerName, emptyDayFn) {
    const dateKey = todayKey();
    if (!this.data.days[dateKey]) this.data.days[dateKey] = { providers: {} };
    if (!this.data.days[dateKey].providers) this.data.days[dateKey].providers = {};
    if (!this.data.days[dateKey].providers[providerName]) {
      this.data.days[dateKey].providers[providerName] = emptyDayFn
        ? emptyDayFn()
        : { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey: {} };
    }
    return this.data.days[dateKey].providers[providerName];
  }

  /** Record a request for a provider/key. */
  recordRequest(providerName, keyId) {
    const day = this.getProviderDay(providerName);
    day.requests = (day.requests || 0) + 1;
    if (keyId) {
      if (!day.perKey) day.perKey = {};
      if (!day.perKey[keyId]) day.perKey[keyId] = { requests: 0, rateLimited: 0, errors: 0 };
      day.perKey[keyId].requests++;
    }
    this._dirty = true;
  }

  /** Record a rate limit event. */
  recordRateLimit(providerName, keyId) {
    const day = this.getProviderDay(providerName);
    day.rateLimited = (day.rateLimited || 0) + 1;
    if (keyId && day.perKey?.[keyId]) {
      day.perKey[keyId].rateLimited++;
    }
    this._dirty = true;
  }

  /** Record an error. */
  recordError(providerName, keyId) {
    const day = this.getProviderDay(providerName);
    day.errors = (day.errors || 0) + 1;
    if (keyId && day.perKey?.[keyId]) {
      day.perKey[keyId].errors++;
    }
    this._dirty = true;
  }

  /** Record circuit break event. */
  recordCircuitBreak(providerName) {
    const day = this.getProviderDay(providerName);
    day.circuitBreaks = (day.circuitBreaks || 0) + 1;
    this._dirty = true;
  }

  /**
   * Record a latency measurement in daily stats.
   * @param {string} providerName
   * @param {string} keyId
   * @param {number} durationMs
   */
  recordLatency(providerName, keyId, durationMs) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const day = this.getProviderDay(providerName);

    // Provider-level latency aggregate
    if (!day.latency) day.latency = { count: 0, totalMs: 0, minMs: null, maxMs: 0 };
    day.latency.count++;
    day.latency.totalMs += durationMs;
    day.latency.minMs = day.latency.minMs == null ? durationMs : Math.min(day.latency.minMs, durationMs);
    if (durationMs > day.latency.maxMs) day.latency.maxMs = durationMs;

    // Per-key latency aggregate
    if (keyId && day.perKey?.[keyId]) {
      const pk = day.perKey[keyId];
      if (!pk.latency) pk.latency = { count: 0, totalMs: 0, minMs: null, maxMs: 0 };
      pk.latency.count++;
      pk.latency.totalMs += durationMs;
      pk.latency.minMs = pk.latency.minMs == null ? durationMs : Math.min(pk.latency.minMs, durationMs);
      if (durationMs > pk.latency.maxMs) pk.latency.maxMs = durationMs;
    }
    this._dirty = true;
  }

  /**
   * Record token usage and estimated cost for a request.
   * @param {string} providerName
   * @param {string} keyId
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @param {number} costPerRequest - Estimated cost in dollars (from pricing config)
   */
  recordTokens(providerName, keyId, inputTokens, outputTokens, costPerRequest) {
    const day = this.getProviderDay(providerName);
    if (!day.tokens) day.tokens = { input: 0, output: 0 };
    day.tokens.input += inputTokens || 0;
    day.tokens.output += outputTokens || 0;

    if (!day.estimatedCost) day.estimatedCost = 0;
    day.estimatedCost += costPerRequest || 0;

    // Per-key token tracking
    if (keyId && day.perKey?.[keyId]) {
      const pk = day.perKey[keyId];
      if (!pk.tokens) pk.tokens = { input: 0, output: 0 };
      pk.tokens.input += inputTokens || 0;
      pk.tokens.output += outputTokens || 0;
    }
    this._dirty = true;
  }

  /**
   * Record smush compression stats for a request.
   * @param {string} providerName
   * @param {object} smushStats - Per-request stats from smush()
   * @param {number} [costPerToken] - Estimated cost per token (from pricing config)
   */
  recordSmush(providerName, smushStats, costPerToken = 0) {
    const day = this.getProviderDay(providerName);
    if (!day.smush) day.smush = {
      requests: 0, bytesSaved: 0, tokensSaved: 0, costSaved: 0,
      cacheHits: 0, cmdCompressed: 0, summarized: 0, textCompressed: 0,
    };
    const s = day.smush;
    s.requests++;
    s.bytesSaved += smushStats.bytesSaved || 0;
    s.tokensSaved += smushStats.tokensSaved || 0;
    s.costSaved += (smushStats.tokensSaved || 0) * costPerToken;
    s.cacheHits += smushStats.cacheHits || 0;
    s.cmdCompressed += smushStats.cmdCompressed || 0;
    s.summarized += smushStats.summarized || 0;
    s.textCompressed += smushStats.textCompressed || 0;
    this._dirty = true;
  }

  /** Record all-keys-exhausted event. */
  recordAllKeysExhausted(providerName) {
    const day = this.getProviderDay(providerName);
    day.allKeysExhausted = (day.allKeysExhausted || 0) + 1;
    this._dirty = true;
  }

  _pruneDays() {
    const keys = Object.keys(this.data.days).sort();
    while (keys.length > this.retentionDays) {
      delete this.data.days[keys.shift()];
    }
  }

  /** Async flush to disk (non-blocking). */
  async flush() {
    if (!this._dirty || this._flushing) return;
    this._flushing = true;
    this._pruneDays();
    const snapshot = JSON.stringify(this.data, null, 2);
    try {
      const dir = path.dirname(this.file);
      await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
      const tmp = this.file + ".tmp";
      await fs.promises.writeFile(tmp, snapshot);
      await fs.promises.rename(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.error(`[ffai:stats] flush error: ${err.message}`);
      try { await fs.promises.unlink(this.file + ".tmp"); } catch {}
    } finally {
      this._flushing = false;
    }
  }

  /** Sync flush for shutdown/crash paths only. */
  flushSync() {
    if (!this._dirty && !this._flushing) return;
    // Block any in-flight async flush from overwriting our data
    this._flushing = true;
    this._pruneDays();
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this.file + ".sync.tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      console.error(`[ffai:stats] sync flush error: ${err.message}`);
      try { fs.unlinkSync(this.file + ".sync.tmp"); } catch {}
    } finally {
      this._flushing = false;
    }
  }

  /** Stop the periodic flush timer. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Aggregate usage stats across a date range with optional pricing.
   * @param {string[]} [dateKeys] - Array of date keys to include (default: all)
   * @param {object} [pricing] - Provider pricing: { providerName: { input, output } } (rates per 1M tokens)
   * @returns {object} Aggregated usage stats
   */
  aggregateUsage(dateKeys, pricing = {}) {
    const keys = dateKeys || Object.keys(this.data.days);
    const totals = {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostAvoided: 0,
      byProvider: {},
    };

    for (const dk of keys) {
      const dayData = this.data.days[dk];
      if (!dayData?.providers) continue;
      for (const [prov, provData] of Object.entries(dayData.providers)) {
        const reqs = provData.requests || 0;
        const inTok = provData.tokens?.input || 0;
        const outTok = provData.tokens?.output || 0;

        totals.requests += reqs;
        totals.inputTokens += inTok;
        totals.outputTokens += outTok;

        if (!totals.byProvider[prov]) {
          totals.byProvider[prov] = { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostAvoided: 0 };
        }
        totals.byProvider[prov].requests += reqs;
        totals.byProvider[prov].inputTokens += inTok;
        totals.byProvider[prov].outputTokens += outTok;

        // Calculate cost avoided using provider pricing or default
        const rates = pricing[prov] || pricing.default || null;
        if (rates) {
          const cost = (inTok / 1_000_000) * (rates.input || 0) + (outTok / 1_000_000) * (rates.output || 0);
          totals.estimatedCostAvoided += cost;
          totals.byProvider[prov].estimatedCostAvoided += cost;
        }
      }
    }

    return totals;
  }

    /**
   * Aggregate smush stats across a date range.
   * @param {string[]} [dateKeys] - Array of date keys to include (default: all)
   * @returns {object} Aggregated smush stats
   */
  aggregateSmush(dateKeys) {
    const keys = dateKeys || Object.keys(this.data.days);
    const totals = {
      requests: 0, bytesSaved: 0, tokensSaved: 0, costSaved: 0,
      cacheHits: 0, cmdCompressed: 0, summarized: 0, textCompressed: 0,
      byProvider: {},
    };

    for (const dk of keys) {
      const dayData = this.data.days[dk];
      if (!dayData?.providers) continue;
      for (const [prov, provData] of Object.entries(dayData.providers)) {
        if (!provData.smush) continue;
        const s = provData.smush;
        totals.requests += s.requests || 0;
        totals.bytesSaved += s.bytesSaved || 0;
        totals.tokensSaved += s.tokensSaved || 0;
        totals.costSaved += s.costSaved || 0;
        totals.cacheHits += s.cacheHits || 0;
        totals.cmdCompressed += s.cmdCompressed || 0;
        totals.summarized += s.summarized || 0;
        totals.textCompressed += s.textCompressed || 0;

        if (!totals.byProvider[prov]) {
          totals.byProvider[prov] = { requests: 0, tokensSaved: 0, costSaved: 0 };
        }
        totals.byProvider[prov].requests += s.requests || 0;
        totals.byProvider[prov].tokensSaved += s.tokensSaved || 0;
        totals.byProvider[prov].costSaved += s.costSaved || 0;
      }
    }

    return totals;
  }

  /** Get all stats data (for /stats endpoint). */
  toJSON() {
    return {
      startedAt: this.data.startedAt,
      uptimeMs: Date.now() - this.data.startedAt,
      days: this.data.days,
    };
  }
}

module.exports = Stats;
