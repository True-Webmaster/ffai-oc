/**
 * KeyScorer — intelligent key selection with token-aware scoring.
 *
 * Scores API keys by RPM/TPM/RPD usage ratios, cooldown proximity,
 * error history, and recency. Supports adaptive RPM learning from 429s
 * and per-key circuit breakers.
 *
 * This is the core brain of FFAI's rotation engine.
 */
const SlidingWindow = require("./sliding-window");
const { todayKey } = require("./utils");
const { nextDailyReset } = require("./free-tier");

class KeyScorer {
  /**
   * @param {object} opts
   * @param {string[]} opts.keys         - Array of API key strings
   * @param {function} opts.keyId        - (key) => string — returns display ID for a key
   * @param {function} opts.getCooldown  - (key) => number — returns cooldown-until timestamp
   * @param {string}   [opts.name]       - Provider name (for logging)
   * @param {number}   [opts.rpmLimit]   - Requests per minute limit (0 = unlimited)
   * @param {number}   [opts.tpmLimit]   - Tokens per minute limit (0 = unlimited)
   * @param {number}   [opts.rpdLimit]   - Requests per day limit (0 = unlimited)
   * @param {number}   [opts.keyCbThreshold] - Consecutive errors before per-key CB (default: 3)
   * @param {number}   [opts.keyCbCooldown]  - Per-key CB cooldown ms (default: 120000)
   * @param {object}   [opts.latencyTracker] - LatencyTracker instance for latency-aware scoring
   * @param {object}   [opts.logger]     - Logger with .log() and .warn() methods
   */
  constructor(opts) {
    this.keys = opts.keys;
    this.keyId = opts.keyId;
    this.getCooldown = opts.getCooldown;
    this.name = opts.name || "unnamed";
    this.logger = opts.logger || console;

    // Per-key state
    this.windows = new Map();           // key → SlidingWindow (1-minute)
    this.dailyUsage = new Map();        // key → { date, requests, tokens }
    this.consecutiveErrors = new Map(); // key → count
    this.recentErrors = new Map();      // key → count of errors in current minute
    this.recentRequests = new Map();    // key → count of requests in current minute
    this.keyCbUntil = new Map();        // key → timestamp (per-key circuit breaker)
    this.lastUsed = new Map();          // key → timestamp (for LRU tie-breaking)
    this.learnedRpm = new Map();        // key → learned RPM limit
    this.learnedTpm = new Map();        // key → learned TPM limit
    this.learnedTpmTs = new Map();      // key → timestamp of last TPM learn
    this.learnedRpd = new Map();        // key → learned RPD limit
    this.learnedRpdTs = new Map();      // key → timestamp of last RPD learn

    // Config
    this.rpmLimit = opts.rpmLimit || 0;
    this.tpmLimit = opts.tpmLimit || 0;
    this.rpdLimit = opts.rpdLimit || 0;
    this.tpdLimit = opts.tpdLimit || 0; // Fix #7: tokens per day limit
    this.keyCbThreshold = opts.keyCbThreshold ?? 3;
    this.keyCbCooldown = opts.keyCbCooldown ?? 120000;
    this.maxConcurrent = opts.maxConcurrent ?? 0; // Fix #17: hard cap (0 = unlimited)

    // Configurable CB trip parameters
    this._invalidKeyBreakMs = opts.invalidKeyBreakMs ?? 0; // 0 = default formula
    this._cbFailRate = opts.cbFailRate > 0 ? opts.cbFailRate : 0; // 0 = use defaults
    this._cbMinRequests = opts.cbMinRequests > 0 ? opts.cbMinRequests : 0; // 0 = use defaults
    this._cbMaxBackoff = opts.cbMaxBackoff ?? 8;

    // Latency tracker reference (for latency-aware scoring)
    this.latencyTracker = opts.latencyTracker || null;

    // Per-model limit overrides: { modelName: { rpm, tpm, rpd, tpd } }
    this.modelLimits = opts.modelLimits || {};

    // Model alias resolution: strip date suffixes, -preview, -latest, etc.
    // Fix #11: model alias/prefix matching
    this.modelAliases = opts.modelAliases || {};

    // Per-key-per-model windows for model-specific rate tracking
    this.modelWindows = new Map(); // key → Map<model, SlidingWindow>
    this._maxModelWindows = 50; // Fix #5: cap per-key model windows

    // In-flight request counter (prevents burst over-allocation)
    this.pending = new Map(); // key → count of in-flight requests

    // Fix #12: per-key CB backoff tracking
    this.keyCbBackoff = new Map(); // key → current backoff multiplier

    // Fix #2: learnedRpm recovery — track when learning happened
    this.learnedRpmTs = new Map(); // key → timestamp of last learn
    this._learnedRpmDecayMs = 300000; // 5 min: decay toward configured RPM

    // Fix #15: active stream counter (not reset by sliding window expiry)
    this.activeStreams = new Map(); // key → count

    // Provider-aware daily reset: uses provider timezone if available, else UTC midnight
    this._providerName = this.name;
    this._dailyResetTs = 0; // cached next reset timestamp

    // Wall 5: shared-quota detection — track recent 429 timestamps per key
    this._recent429s = new Map();           // key → timestamp of last 429
    this._sharedQuotaWarned = false;        // only warn once

    // Initialize per-key state
    for (const key of this.keys) {
      this.windows.set(key, new SlidingWindow(60000, 60));
      this.dailyUsage.set(key, { date: todayKey(), requests: 0, tokens: 0 });
      this.consecutiveErrors.set(key, 0);
      this.lastUsed.set(key, 0);
      this.modelWindows.set(key, new Map());
      this.pending.set(key, 0);
      this.keyCbBackoff.set(key, 1);
      this.activeStreams.set(key, 0);
    }
  }

  // ── Model-aware helpers ────────────────────────────────────────────────────

  /** Get or create a per-model sliding window for a key. */
  _getModelWindow(key, model) {
    if (!model) return null;
    const resolved = this._resolveModel(model);
    const keyWindows = this.modelWindows.get(key);
    if (!keyWindows) return null;
    if (!keyWindows.has(resolved)) {
      // Fix #5: evict oldest if at capacity
      if (keyWindows.size >= this._maxModelWindows) {
        const oldest = keyWindows.keys().next().value;
        keyWindows.delete(oldest);
      }
      keyWindows.set(resolved, new SlidingWindow(60000, 60));
    }
    return keyWindows.get(resolved);
  }

  /**
   * Resolve a model name to its canonical form via aliases and prefix matching.
   * Fix #11: model alias resolution.
   * @param {string|null} model
   * @returns {string|null}
   */
  _resolveModel(model) {
    if (!model) return null;
    // Direct alias (follow up to 2 levels to handle alias chains)
    let resolved = this.modelAliases[model];
    if (resolved) {
      return this.modelAliases[resolved] || resolved;
    }
    // Exact match in modelLimits
    if (this.modelLimits[model]) return model;
    // Prefix match: "gemini-2.5-pro-preview-05-06" → "gemini-2.5-pro"
    // Sort by length descending to match longest prefix first
    const keys = Object.keys(this.modelLimits).sort((a, b) => b.length - a.length);
    for (const known of keys) {
      if (model.startsWith(known)) return known;
    }
    return model;
  }

  /** Get effective limits for a model (model-specific or provider defaults). */
  _getModelLimits(model) {
    const resolved = this._resolveModel(model);
    const ml = resolved ? this.modelLimits[resolved] : null;
    return {
      rpm: ml?.rpm ?? this.rpmLimit,
      tpm: ml?.tpm ?? this.tpmLimit,
      rpd: ml?.rpd ?? this.rpdLimit,
      tpd: ml?.tpd ?? this.tpdLimit,
    };
  }

  /**
   * Get effective RPM for a key, with decay toward configured RPM.
   * Fix #2: learnedRpm decays back toward configured limit over time.
   * @param {string} key
   * @param {number} configuredRpm
   * @returns {number}
   */
  _getEffectiveRpm(key, configuredRpm) {
    const learned = this.learnedRpm.get(key);
    if (!learned || learned >= configuredRpm) return learned || configuredRpm;
    const learnedTs = this.learnedRpmTs.get(key) || 0;
    const elapsed = Date.now() - learnedTs;
    if (elapsed < this._learnedRpmDecayMs) return learned;
    // Decay: after decayMs, move 20% back toward configured per decay period
    const periods = Math.floor(elapsed / this._learnedRpmDecayMs);
    let effective = learned;
    for (let i = 0; i < periods && effective < configuredRpm; i++) {
      effective = Math.min(configuredRpm, Math.ceil(effective + (configuredRpm - effective) * 0.2));
    }
    return effective;
  }

  /**
   * Get effective TPM for a key, with decay toward configured TPM.
   * Mirrors _getEffectiveRpm with same 5-min decay logic.
   * @param {string} key
   * @param {number} configuredTpm
   * @returns {number}
   */
  _getEffectiveTpm(key, configuredTpm) {
    const learned = this.learnedTpm.get(key);
    if (!learned || learned >= configuredTpm) return learned || configuredTpm;
    const learnedTs = this.learnedTpmTs.get(key) || 0;
    const elapsed = Date.now() - learnedTs;
    if (elapsed < this._learnedRpmDecayMs) return learned;
    const periods = Math.floor(elapsed / this._learnedRpmDecayMs);
    let effective = learned;
    for (let i = 0; i < periods && effective < configuredTpm; i++) {
      effective = Math.min(configuredTpm, Math.ceil(effective + (configuredTpm - effective) * 0.2));
    }
    return effective;
  }

  /**
   * Get effective RPD for a key, with decay toward configured RPD.
   * Mirrors _getEffectiveRpm with same 5-min decay logic.
   * @param {string} key
   * @param {number} configuredRpd
   * @returns {number}
   */
  _getEffectiveRpd(key, configuredRpd) {
    const learned = this.learnedRpd.get(key);
    if (!learned || learned >= configuredRpd) return learned || configuredRpd;
    const learnedTs = this.learnedRpdTs.get(key) || 0;
    const elapsed = Date.now() - learnedTs;
    if (elapsed < this._learnedRpmDecayMs) return learned;
    const periods = Math.floor(elapsed / this._learnedRpmDecayMs);
    let effective = learned;
    for (let i = 0; i < periods && effective < configuredRpd; i++) {
      effective = Math.min(configuredRpd, Math.ceil(effective + (configuredRpd - effective) * 0.2));
    }
    return effective;
  }

  // ── Core: select best available key ──────────────────────────────────────────

  /**
   * Select the best available key based on scoring.
   * Returns null if all keys are exhausted (CB or cooldown).
   *
   * @param {string|null} [model=null]      - Model name for model-specific limits
   * @param {number}      [inputTokens=0]   - Estimated input tokens for headroom check
   * @returns {string | null}
   */
  selectKey(model = null, inputTokens = 0) {
    const now = Date.now();
    const candidates = []; // { key, score }
    let allCircuitOpen = true;

    for (const key of this.keys) {
      // Per-key circuit breaker
      const cbUntil = this.keyCbUntil.get(key) || 0;
      if (now < cbUntil) continue;
      allCircuitOpen = false;

      // Cooldown from 429
      if (this.getCooldown(key) > now) continue;

      // Fix #17: hard cap on concurrent in-flight requests (pending + active streams)
      if (this.maxConcurrent > 0) {
        const inFlight = (this.pending.get(key) || 0) + (this.activeStreams.get(key) || 0);
        if (inFlight >= this.maxConcurrent) continue;
      }

      const score = this._scoreKey(key, now, model, inputTokens);
      candidates.push({ key, score });
    }

    if (allCircuitOpen && this.keys.length > 0) return null;
    if (candidates.length === 0) return null;

    // Buffer-zone pick: collect keys within 20% of best score range.
    // Prefer the most recently used key for cache locality (Gemini prompt
    // caching is per-key), only rotate when the sticky key is rate-limited.
    candidates.sort((a, b) => b.score - a.score);
    const bestScore = candidates[0].score;
    const scoreRange = Math.max(bestScore - candidates[candidates.length - 1].score, 0.01);
    const buffer = scoreRange * 0.2; // 20% of score range
    const eligible = candidates.filter(c => c.score >= bestScore - buffer);

    // Sticky key: if the most recently used key is still eligible, reuse it
    let picked;
    const mruKey = this._findMruEligible(eligible);
    if (mruKey) {
      picked = mruKey;
    } else {
      // No sticky candidate — random pick among eligible (thundering herd prevention)
      picked = eligible[Math.floor(Math.random() * eligible.length)];
    }

    // Immediately mark as used and increment in-flight counter
    this.lastUsed.set(picked.key, Date.now());
    this.pending.set(picked.key, (this.pending.get(picked.key) || 0) + 1);

    return picked.key;
  }

  /**
   * Find the most recently used key among eligible candidates.
   * Returns the candidate object if found, null otherwise.
   */
  _findMruEligible(eligible) {
    if (eligible.length <= 1) return null; // no choice to make
    let best = null;
    let bestTs = 0;
    for (const c of eligible) {
      const ts = this.lastUsed.get(c.key) || 0;
      if (ts > bestTs) { bestTs = ts; best = c; }
    }
    return bestTs > 0 ? best : null;
  }

  _scoreKey(key, now, model = null, inputTokens = 0) {
    const w = this.windows.get(key).totals();
    const daily = this._getDailyUsage(key);
    const limits = this._getModelLimits(model);

    // Fix #2: decay learnedRpm back toward configured RPM over time
    const effectiveRpm = this._getEffectiveRpm(key, limits.rpm);
    const effectiveTpm = this._getEffectiveTpm(key, limits.tpm);
    const effectiveRpd = this._getEffectiveRpd(key, limits.rpd);
    const rpmRatio = effectiveRpm > 0 ? w.requests / effectiveRpm : 0;
    const tpmRatio = effectiveTpm > 0 ? w.tokens / effectiveTpm : 0;
    const rpdRatio = effectiveRpd > 0 ? daily.requests / effectiveRpd : 0;
    // Fix #7: tokens per day ratio
    const tpdRatio = limits.tpd > 0 ? daily.tokens / limits.tpd : 0;

    // Per-model tracking: resolve aliases first (Fix #11)
    const resolvedModel = this._resolveModel(model);
    let modelRpmRatio = 0, modelTpmRatio = 0;
    if (resolvedModel && this.modelLimits[resolvedModel]) {
      const mw = this._getModelWindow(key, model);
      if (mw) {
        const mt = mw.totals();
        const ml = this.modelLimits[resolvedModel];
        if (ml.rpm > 0) modelRpmRatio = mt.requests / ml.rpm;
        if (ml.tpm > 0) modelTpmRatio = mt.tokens / ml.tpm;
      }
    }

    // Factor in-flight (pending) + active streams into RPM ratio
    const pendingCount = this.pending.get(key) || 0;
    const streams = this.activeStreams.get(key) || 0; // Fix #15
    const effectiveRpmWithPending = effectiveRpm > 0
      ? (w.requests + pendingCount + streams) / effectiveRpm : 0;
    const rpmRatioWithPending = Math.max(rpmRatio, effectiveRpmWithPending);

    // Score = how much capacity remains (1.0 = fully idle, 0.0 = at limit)
    const usageRatio = Math.max(rpmRatioWithPending, tpmRatio, rpdRatio, tpdRatio, modelRpmRatio, modelTpmRatio);
    let score = 1.0 - usageRatio;

    // Fix #14: smooth exponential ramp instead of cliff at 90%
    if (usageRatio > 0.7) {
      score -= Math.pow((usageRatio - 0.7) / 0.3, 2) * 2.0;
    }

    // Input-token-aware: penalize if this request would push TPM over limit
    if (inputTokens > 0 && limits.tpm > 0) {
      const projectedTpm = w.tokens + inputTokens;
      if (projectedTpm > limits.tpm * 0.95) score -= 1.5;
    }

    // LRU tie-breaking: slightly prefer keys not used recently
    const idleMs = now - (this.lastUsed.get(key) || 0);
    const idleBonus = Math.min(idleMs / 60000, 1.0) * 0.1;
    score += idleBonus;

    // Penalize keys with recent consecutive errors (but not CB-open)
    const consErrors = this.consecutiveErrors.get(key) || 0;
    if (consErrors > 0) score -= consErrors * 0.3;

    // Latency penalty: uses per-token normalized latency when available,
    // falls back to TTFT for streaming-heavy keys, then raw p50.
    // Keys with latency > 2x provider average get penalized.
    if (this.latencyTracker) {
      const kid = this.keyId(key);
      // Prefer per-token normalization (fairer: long responses don't penalize fast keys)
      let keyLat = this.latencyTracker.perTokenStats(kid);
      let provLat = this.latencyTracker.perTokenProviderStats();
      // Fallback to TTFT (streaming-focused)
      if (!keyLat || !provLat) {
        keyLat = this.latencyTracker.ttftStats(kid);
        provLat = this.latencyTracker.ttftProviderStats();
      }
      // Fallback to raw latency
      if (!keyLat || !provLat) {
        keyLat = this.latencyTracker.keyStats(kid);
        provLat = this.latencyTracker.providerStats();
      }
      if (keyLat && provLat && provLat.avg > 0) {
        const ratio = keyLat.p50 / provLat.avg;
        if (ratio > 2.0) {
          // Scale penalty: 2x = -0.2, 3x = -0.4, etc.
          score -= Math.min((ratio - 2.0) * 0.2, 0.6);
        }
      }
    }

    return score;
  }

  // ── Recording methods ────────────────────────────────────────────────────────

  /**
   * Record that a request was sent using this key.
   * Fix #9: countInWindow defaults true but should be false for non-429 failures
   * (5xx/network errors don't consume upstream quota).
   * @param {string} key
   * @param {number} [inputTokens=0]
   * @param {string|null} [model=null]
   * @param {boolean} [countInWindow=true] - Whether to count in rate windows
   */
  recordRequest(key, inputTokens = 0, model = null, countInWindow = true) {
    if (!this.windows.has(key)) return; // Unknown key — don't corrupt state
    if (countInWindow) {
      this.windows.get(key)?.record(1, inputTokens);
      const daily = this._getDailyUsage(key);
      daily.requests++;
      daily.tokens += inputTokens;

      // Per-model tracking
      if (model) {
        const mw = this._getModelWindow(key, model);
        if (mw) mw.record(1, inputTokens);
      }
    }
    this.lastUsed.set(key, Date.now());
    // Decrement in-flight counter (was incremented in selectKey)
    this._decrementPending(key);
  }

  /** Decrement pending counter safely (idempotent, never goes negative). */
  _decrementPending(key) {
    const p = this.pending.get(key) || 0;
    if (p > 0) this.pending.set(key, p - 1);
  }

  /**
   * Record output tokens from a response.
   * @param {string} key
   * @param {number} [outputTokens=0]
   * @param {string|null} [model=null]
   */
  recordResponse(key, outputTokens = 0, model = null) {
    if (!this.windows.has(key)) return; // Unknown key
    this.windows.get(key)?.record(0, outputTokens);
    const daily = this._getDailyUsage(key);
    daily.tokens += outputTokens;

    if (model) {
      const mw = this._getModelWindow(key, model);
      if (mw) mw.record(0, outputTokens);
    }
  }

  /** Record a successful response (resets consecutive error counter and CB backoff). */
  recordSuccess(key) {
    if (!this.windows.has(key)) return; // Unknown key
    this.consecutiveErrors.set(key, 0);
    this.keyCbBackoff.set(key, 1); // Fix #12: reset backoff on success
    // Track request for percentage-based cooldown
    this.recentRequests.set(key, (this.recentRequests.get(key) || 0) + 1);
  }

  /**
   * Record an error response.
   * Uses percentage-based cooldown: trips circuit breaker when failure rate > 50%
   * with a minimum request floor. Single-key groups get special protection
   * (100% failure rate, higher floor) to avoid cooldowning your only key.
   *
   * @param {string} key
   * @param {number|null} [statusCode]
   */
  recordError(key, statusCode = null) {
    if (!this.windows.has(key)) return; // Unknown key
    const count = (this.consecutiveErrors.get(key) || 0) + 1;
    this.consecutiveErrors.set(key, count);
    this.recentErrors.set(key, (this.recentErrors.get(key) || 0) + 1);
    this.recentRequests.set(key, (this.recentRequests.get(key) || 0) + 1);

    if (statusCode === 429) {
      this._learnFromRateLimit(key);
      this._checkSharedQuota(key);
    }

    // Fix #16: immediate hard-break on auth failures (key revoked/invalid)
    if (statusCode === 401 || statusCode === 403) {
      const hardBreakMs = this._invalidKeyBreakMs > 0
        ? this._invalidKeyBreakMs
        : Math.max(this.keyCbCooldown * 10, 1800000); // 30 min minimum default
      this.keyCbUntil.set(key, Date.now() + hardBreakMs);
      this.consecutiveErrors.set(key, this.keyCbThreshold);
      const kid = this.keyId(key);
      this.logger.warn(`[ffai:${this.name}:scorer] ${kid} AUTH FAILED (${statusCode}) — hard circuit break for ${hardBreakMs / 1000}s`);
      return;
    }

    // Percentage-based cooldown with single-key protection
    const isSingleKey = this.keys.length === 1;
    const recentReqs = this.recentRequests.get(key) || 0;
    const recentErrs = this.recentErrors.get(key) || 0;
    const failRate = recentReqs > 0 ? recentErrs / recentReqs : 0;

    // Configurable thresholds (per-provider via config.json cb_fail_rate / cb_min_requests)
    // Single-key: need 100% failure rate with 20+ requests (don't cooldown your only key!)
    // Multi-key: need >50% failure rate with 5+ requests, OR consecutive threshold
    const multiFailRate = this._cbFailRate > 0 ? this._cbFailRate : 0.5;
    const multiMinReqs = this._cbMinRequests > 0 ? this._cbMinRequests : 5;
    const singleMinReqs = this._cbMinRequests > 0 ? this._cbMinRequests * 4 : 20;
    const shouldTrip = isSingleKey
      ? (failRate >= 1.0 && recentReqs >= singleMinReqs)
      : (failRate > multiFailRate && recentReqs >= multiMinReqs) || count >= this.keyCbThreshold;

    if (shouldTrip) {
      const backoff = this.keyCbBackoff.get(key) || 1;
      const cooldownMs = this.keyCbCooldown * backoff;
      const until = Date.now() + cooldownMs;
      this.keyCbUntil.set(key, until);
      // Increase backoff for next time (cap at configured max)
      this.keyCbBackoff.set(key, Math.min(backoff * 2, this._cbMaxBackoff));
      // Reset counters for next period
      this.recentErrors.set(key, 0);
      this.recentRequests.set(key, 0);
      const kid = this.keyId(key);
      const reason = count >= this.keyCbThreshold
        ? `${count} consecutive errors`
        : `${(failRate * 100).toFixed(0)}% failure rate (${recentErrs}/${recentReqs})`;
      this.logger.log(`[ffai:${this.name}:scorer] ${kid} circuit open (${reason}), isolating for ${cooldownMs / 1000}s (backoff ${backoff}x)`);
    }
  }

  // ── Rate-limit header ingestion ──────────────────────────────────────────────

  /**
   * Ingest rate limit headers from an upstream response to learn real limits.
   * @param {string} key
   * @param {object} headers - Response headers object
   */
  ingestRateLimitHeaders(key, headers) {
    if (!headers) return;

    // Fix #6: Normalize Anthropic headers to standard x-ratelimit format
    // Anthropic uses: anthropic-ratelimit-requests-limit, anthropic-ratelimit-requests-remaining, etc.
    const limitReqs = parseInt(
      headers["x-ratelimit-limit-requests"] ||
      headers["anthropic-ratelimit-requests-limit"] ||
      headers["ratelimit-limit"], 10);
    const remainReqs = parseInt(
      headers["x-ratelimit-remaining-requests"] ||
      headers["anthropic-ratelimit-requests-remaining"] ||
      headers["ratelimit-remaining"], 10);

    // ── RPM / Groq RPD detection ──────────────────────────────────────────────
    if (Number.isFinite(limitReqs) && limitReqs > 0) {
      // Groq reports RPD in the x-ratelimit-limit-requests header (e.g., 14400)
      // Detect: provider starts with "groq" AND value > 1000 → treat as RPD
      const isGroqRpd = this.name.toLowerCase().startsWith("groq") && limitReqs > 1000;

      if (isGroqRpd) {
        const currentRpd = this.learnedRpd.get(key) || this.rpdLimit;
        if (limitReqs < currentRpd || !this.learnedRpd.has(key)) {
          this.learnedRpd.set(key, limitReqs);
          this.learnedRpdTs.set(key, Date.now());
          const kid = this.keyId(key);
          this.logger.log(`[ffai:${this.name}:scorer] ${kid} learned RPD from Groq headers: ${currentRpd} -> ${limitReqs}`);
          this._propagateLearnedRpd(limitReqs, key);
        }
        // Sync daily usage from remaining header
        if (Number.isFinite(remainReqs) && remainReqs >= 0) {
          const providerUsed = limitReqs - remainReqs;
          const daily = this._getDailyUsage(key);
          if (providerUsed > daily.requests) {
            const kid = this.keyId(key);
            this.logger.log(`[ffai:${this.name}:scorer] ${kid} synced RPD from remaining header: ${daily.requests} -> ${providerUsed} used (${remainReqs} remaining)`);
            daily.requests = providerUsed;
          }
        }
      } else {
        // Standard RPM learning
        const current = this.learnedRpm.get(key) || this.rpmLimit || Infinity;
        // Only update if provider reports a LOWER limit than we know (or first discovery when rpmLimit=0)
        if (limitReqs < current || (current === Infinity && !this.learnedRpm.has(key))) {
          this.learnedRpm.set(key, limitReqs);
          this.learnedRpmTs.set(key, Date.now()); // Fix #2
          const kid = this.keyId(key);
          this.logger.log(`[ffai:${this.name}:scorer] ${kid} learned RPM from headers: ${current} -> ${limitReqs}`);
          // Cross-key propagation
          this._propagateLearnedRpm(limitReqs, key);
        }

        // Sync our window to match reality: if provider says "3 remaining of 15",
        // set effective request count = limit - remaining so our tracker matches
        if (Number.isFinite(remainReqs) && remainReqs >= 0) {
          const providerUsed = limitReqs - remainReqs;
          const w = this.windows.get(key);
          if (w) {
            const current = w.totals().requests;
            // Only correct upward (provider says we used more than we think)
            // to avoid under-counting. Never reduce our own count.
            if (providerUsed > current) {
              // Inject the delta into the current bucket
              w.record(providerUsed - current, 0);
              const kid = this.keyId(key);
              this.logger.log(`[ffai:${this.name}:scorer] ${kid} synced RPM from remaining header: ${current} -> ${providerUsed} used (${remainReqs} remaining)`);
            }
          }
        }
      }
    }

    // ── TPM learning ──────────────────────────────────────────────────────────
    const limitTokens = parseInt(
      headers["x-ratelimit-limit-tokens"] ||
      headers["anthropic-ratelimit-tokens-limit"], 10);
    const remainTokens = parseInt(
      headers["x-ratelimit-remaining-tokens"] ||
      headers["anthropic-ratelimit-tokens-remaining"], 10);

    if (Number.isFinite(limitTokens) && limitTokens > 0) {
      const currentTpm = this.learnedTpm.get(key) || this.tpmLimit;
      if (limitTokens < currentTpm || !this.learnedTpm.has(key)) {
        this.learnedTpm.set(key, limitTokens);
        this.learnedTpmTs.set(key, Date.now());
        const kid = this.keyId(key);
        this.logger.log(`[ffai:${this.name}:scorer] ${kid} learned TPM from headers: ${currentTpm} -> ${limitTokens}`);
        this._propagateLearnedTpm(limitTokens, key);
      }

      // Sync token window from remaining header
      if (Number.isFinite(remainTokens) && remainTokens >= 0) {
        const providerUsed = limitTokens - remainTokens;
        const w = this.windows.get(key);
        if (w) {
          const currentTokens = w.totals().tokens;
          if (providerUsed > currentTokens) {
            w.record(0, providerUsed - currentTokens);
            const kid = this.keyId(key);
            this.logger.log(`[ffai:${this.name}:scorer] ${kid} synced TPM from remaining header: ${currentTokens} -> ${providerUsed} used (${remainTokens} remaining)`);
          }
        }
      }
    }

    // ── Cerebras day-specific headers → RPD ────────────────────────────────────
    const limitReqsDay = parseInt(headers["x-ratelimit-limit-requests-day"], 10);
    const remainReqsDay = parseInt(headers["x-ratelimit-remaining-requests-day"], 10);

    if (Number.isFinite(limitReqsDay) && limitReqsDay > 0) {
      const currentRpd = this.learnedRpd.get(key) || this.rpdLimit;
      if (limitReqsDay < currentRpd || !this.learnedRpd.has(key)) {
        this.learnedRpd.set(key, limitReqsDay);
        this.learnedRpdTs.set(key, Date.now());
        const kid = this.keyId(key);
        this.logger.log(`[ffai:${this.name}:scorer] ${kid} learned RPD from day headers: ${currentRpd} -> ${limitReqsDay}`);
        this._propagateLearnedRpd(limitReqsDay, key);
      }

      // Sync daily usage from remaining-day header
      if (Number.isFinite(remainReqsDay) && remainReqsDay >= 0) {
        const providerUsed = limitReqsDay - remainReqsDay;
        const daily = this._getDailyUsage(key);
        if (providerUsed > daily.requests) {
          const kid = this.keyId(key);
          this.logger.log(`[ffai:${this.name}:scorer] ${kid} synced RPD from remaining-day header: ${daily.requests} -> ${providerUsed} used (${remainReqsDay} remaining)`);
          daily.requests = providerUsed;
        }
      }
    }
  }

  // ── Adaptive limit learning ──────────────────────────────────────────────────

  _learnFromRateLimit(key) {
    const w = this.windows.get(key).totals();
    const currentLearned = this.learnedRpm.get(key) || this.rpmLimit || Infinity;
    if (currentLearned === Infinity && w.requests <= 2) return; // Nothing to learn from yet
    const minLearnedRpm = Math.max(2, Math.ceil((this.rpmLimit || currentLearned) * 0.5));
    if (w.requests > 2 && w.requests < currentLearned) {
      const newLimit = Math.max(minLearnedRpm, Math.floor(currentLearned * 0.9));
      if (newLimit < currentLearned) {
        this.learnedRpm.set(key, newLimit);
        this.learnedRpmTs.set(key, Date.now()); // Fix #2: track when learned
        const kid = this.keyId(key);
        this.logger.log(`[ffai:${this.name}:scorer] ${kid} learned RPM limit: ${currentLearned} -> ${newLimit} (hit 429 at ${w.requests} rpm)`);
        // Cross-key propagation: provider-level limits apply to all keys
        this._propagateLearnedRpm(newLimit, key);
      }
    }
  }

  /**
   * Propagate a learned RPM limit to all other keys in this provider.
   * Rate limits are typically provider-level, not per-key, so when one key
   * discovers a lower limit, all keys likely share it.
   * Only propagates downward (never increases a key's learned limit).
   * @param {number} newLimit
   * @param {string} sourceKey - The key that learned the limit (skip it)
   */
  _propagateLearnedRpm(newLimit, sourceKey) {
    let propagated = 0;
    const now = Date.now();
    for (const key of this.keys) {
      if (key === sourceKey) continue;
      const current = this.learnedRpm.get(key) || this.rpmLimit;
      if (newLimit < current) {
        this.learnedRpm.set(key, newLimit);
        this.learnedRpmTs.set(key, now);
        propagated++;
      }
    }
    if (propagated > 0) {
      this.logger.log(`[ffai:${this.name}:scorer] propagated RPM limit ${newLimit} to ${propagated} other key(s)`);
    }
  }

  /**
   * Propagate a learned TPM limit to all other keys in this provider.
   * Only propagates downward (never increases a key's learned limit).
   * @param {number} newLimit
   * @param {string} sourceKey
   */
  _propagateLearnedTpm(newLimit, sourceKey) {
    let propagated = 0;
    const now = Date.now();
    for (const key of this.keys) {
      if (key === sourceKey) continue;
      const current = this.learnedTpm.get(key) || this.tpmLimit;
      if (newLimit < current) {
        this.learnedTpm.set(key, newLimit);
        this.learnedTpmTs.set(key, now);
        propagated++;
      }
    }
    if (propagated > 0) {
      this.logger.log(`[ffai:${this.name}:scorer] propagated TPM limit ${newLimit} to ${propagated} other key(s)`);
    }
  }

  /**
   * Propagate a learned RPD limit to all other keys in this provider.
   * Only propagates downward (never increases a key's learned limit).
   * @param {number} newLimit
   * @param {string} sourceKey
   */
  _propagateLearnedRpd(newLimit, sourceKey) {
    let propagated = 0;
    const now = Date.now();
    for (const key of this.keys) {
      if (key === sourceKey) continue;
      const current = this.learnedRpd.get(key) || this.rpdLimit;
      if (newLimit < current) {
        this.learnedRpd.set(key, newLimit);
        this.learnedRpdTs.set(key, now);
        propagated++;
      }
    }
    if (propagated > 0) {
      this.logger.log(`[ffai:${this.name}:scorer] propagated RPD limit ${newLimit} to ${propagated} other key(s)`);
    }
  }

  /**
   * Wall 5: Detect shared-quota keys (e.g., multiple Gemini keys from same GCP project).
   * If 3+ keys all hit 429 within 5 seconds, they likely share a quota.
   * Logs a warning (once) so the operator knows key rotation isn't multiplying throughput.
   */
  _checkSharedQuota(key) {
    if (this._sharedQuotaWarned || this.keys.length < 3) return;

    const now = Date.now();
    this._recent429s.set(key, now);

    // Count how many keys hit 429 within the last 5 seconds
    const WINDOW = 5000;
    let recentCount = 0;
    for (const [, ts] of this._recent429s) {
      if (now - ts < WINDOW) recentCount++;
    }

    // If 80%+ of keys hit 429 in the same window, likely shared quota
    const threshold = Math.max(3, Math.ceil(this.keys.length * 0.8));
    if (recentCount >= threshold) {
      this._sharedQuotaWarned = true;
      this.logger.warn(
        `[ffai:${this.name}:scorer] WARNING: ${recentCount}/${this.keys.length} keys hit 429 within ${WINDOW / 1000}s — ` +
        `keys likely share the same project/account quota. Key rotation will NOT multiply throughput. ` +
        `Use keys from separate projects/accounts for true parallelism.`
      );
    }
  }

  // ── Query methods ────────────────────────────────────────────────────────────

  _getDailyUsage(key) {
    const now = Date.now();
    let shouldReset = false;

    // Check provider-specific daily reset (e.g., Gemini resets at Pacific midnight)
    if (this._dailyResetTs > 0 && now >= this._dailyResetTs) {
      shouldReset = true;
      // Recompute next reset
      try {
        const nextReset = nextDailyReset(this._providerName);
        this._dailyResetTs = nextReset || 0;
      } catch { this._dailyResetTs = 0; }
    } else if (this._dailyResetTs === 0) {
      // First call or no provider-specific reset: try to get one, else fall back to UTC date change
      try {
        const nextReset = nextDailyReset(this._providerName);
        this._dailyResetTs = nextReset || 0;
      } catch { this._dailyResetTs = 0; }
    }

    // UTC date-based reset ONLY if no provider-specific schedule is active.
    // When a provider has a known reset time (e.g., Gemini at Pacific midnight),
    // we trust that schedule exclusively — a UTC date change mid-day would
    // incorrectly zero counters hours before the real reset.
    const today = todayKey();
    let daily = this.dailyUsage.get(key);
    const hasProviderReset = this._dailyResetTs > 0;
    if (shouldReset || !daily || (!hasProviderReset && daily.date !== today)) {
      daily = { date: today, requests: 0, tokens: 0 };
      this.dailyUsage.set(key, daily);
    }
    return daily;
  }

  /** @returns {boolean} True if ALL keys are currently circuit-broken. */
  isAllKeysCircuitOpen() {
    const now = Date.now();
    return this.keys.every(k => (this.keyCbUntil.get(k) || 0) > now);
  }

  /**
   * Get detailed status for each key.
   * @returns {Object.<string, object>} keyId → status
   */
  keyStatuses() {
    const now = Date.now();
    const result = {};
    for (const key of this.keys) {
      const kid = this.keyId(key);
      const w = this.windows.get(key).totals();
      const daily = this._getDailyUsage(key);
      const cbUntil = this.keyCbUntil.get(key) || 0;
      const cooldownUntil = this.getCooldown(key);
      result[kid] = {
        score: parseFloat(this._scoreKey(key, now).toFixed(3)),
        rpm: w.requests,
        tpm: w.tokens,
        rpd: daily.requests,
        pending: this.pending.get(key) || 0,
        learnedRpm: this.learnedRpm.get(key) || null,
        learnedTpm: this.learnedTpm.get(key) || null,
        learnedRpd: this.learnedRpd.get(key) || null,
        consecutiveErrors: this.consecutiveErrors.get(key) || 0,
        perKeyCB: cbUntil > now ? `open (${Math.ceil((cbUntil - now) / 1000)}s)` : "closed",
        cooldown: cooldownUntil > now ? `${Math.ceil((cooldownUntil - now) / 1000)}s` : null,
        lastUsedAgo: this.lastUsed.get(key) ? `${Math.ceil((now - this.lastUsed.get(key)) / 1000)}s` : "never",
        modelWindows: this._getActiveModelStats(key),
      };
    }
    return result;
  }

  /**
   * Get aggregate utilization ratio across all keys (0.0 = idle, 1.0 = saturated).
   * Used to emit x-ffai-utilization pressure header.
   * @param {string|null} [model=null]
   * @returns {number}
   */
  utilization(model = null) {
    if (this.keys.length === 0) return 0;
    const now = Date.now();
    let totalRatio = 0;
    let activeKeys = 0;

    for (const key of this.keys) {
      // Skip circuit-broken keys
      if ((this.keyCbUntil.get(key) || 0) > now) continue;
      if (this.getCooldown(key) > now) continue;
      activeKeys++;

      const w = this.windows.get(key).totals();
      const limits = this._getModelLimits(model);
      const effectiveRpm = this.learnedRpm.get(key) || limits.rpm;
      const pending = this.pending.get(key) || 0;

      const rpmRatio = effectiveRpm > 0 ? (w.requests + pending) / effectiveRpm : 0;
      const tpmRatio = limits.tpm > 0 ? w.tokens / limits.tpm : 0;
      totalRatio += Math.max(rpmRatio, tpmRatio);
    }

    if (activeKeys === 0) return 1.0; // all keys exhausted = fully saturated
    return Math.min(totalRatio / activeKeys, 1.0);
  }

  /**
   * Pre-flight capacity check: estimate whether a key can handle a request
   * without hitting rate limits mid-stream. Returns remaining capacity ratio (0-1).
   * Used to avoid starting streams that will die mid-way on free-tier keys.
   *
   * @param {string} key
   * @param {string|null} [model=null]
   * @param {number} [estimatedTokens=0] - Estimated total tokens (input + output)
   * @returns {{ ok: boolean, rpmRemaining: number, tpmRemaining: number, rpdRemaining: number }}
   */
  preflightCheck(key, model = null, estimatedTokens = 0) {
    const now = Date.now();

    // Check exclusion conditions that selectKey() would enforce
    const cbUntil = this.keyCbUntil.get(key) || 0;
    if (now < cbUntil) return { ok: false, rpmRemaining: 0, tpmRemaining: 0, rpdRemaining: 0, tpdRemaining: 0, reason: "circuit-breaker" };
    if (this.getCooldown(key) > now) return { ok: false, rpmRemaining: 0, tpmRemaining: 0, rpdRemaining: 0, tpdRemaining: 0, reason: "cooldown" };
    if (this.maxConcurrent > 0) {
      const inFlight = (this.pending.get(key) || 0) + (this.activeStreams.get(key) || 0);
      if (inFlight >= this.maxConcurrent) return { ok: false, rpmRemaining: 0, tpmRemaining: 0, rpdRemaining: 0, tpdRemaining: 0, reason: "max-concurrent" };
    }

    const limits = this._getModelLimits(model);
    const w = this.windows.get(key)?.totals() || { requests: 0, tokens: 0 };
    const daily = this._getDailyUsage(key);
    const pending = this.pending.get(key) || 0;
    const streams = this.activeStreams.get(key) || 0;
    // Use learned effective limits (same as scoring path) for consistency
    const effectiveRpm = this._getEffectiveRpm(key, limits.rpm);
    const effectiveTpm = this._getEffectiveTpm(key, limits.tpm);
    const effectiveRpd = this._getEffectiveRpd(key, limits.rpd);

    const rpmUsed = w.requests + pending + streams;
    const rpmRemaining = effectiveRpm > 0 ? Math.max(0, effectiveRpm - rpmUsed) : Infinity;
    const tpmRemaining = effectiveTpm > 0 ? Math.max(0, effectiveTpm - w.tokens) : Infinity;
    const rpdRemaining = effectiveRpd > 0 ? Math.max(0, effectiveRpd - daily.requests) : Infinity;
    const tpdRemaining = limits.tpd > 0 ? Math.max(0, limits.tpd - daily.tokens) : Infinity;

    // Check if there's enough capacity
    const ok = rpmRemaining >= 1 &&
      (estimatedTokens <= 0 || tpmRemaining >= estimatedTokens) &&
      rpdRemaining >= 1 &&
      (estimatedTokens <= 0 || tpdRemaining >= estimatedTokens);

    return { ok, rpmRemaining, tpmRemaining, rpdRemaining, tpdRemaining };
  }

  /** Fix #15: Increment active stream counter for a key. */
  startStream(key) {
    this.activeStreams.set(key, (this.activeStreams.get(key) || 0) + 1);
  }

  /** Fix #15: Decrement active stream counter for a key. */
  endStream(key) {
    const c = this.activeStreams.get(key) || 0;
    if (c > 0) this.activeStreams.set(key, c - 1);
  }

  _getActiveModelStats(key) {
    const keyWindows = this.modelWindows.get(key);
    if (!keyWindows || keyWindows.size === 0) return null;
    const result = {};
    for (const [model, sw] of keyWindows) {
      const t = sw.totals();
      if (t.requests > 0 || t.tokens > 0) {
        const ml = this.modelLimits[model];
        result[model] = { rpm: t.requests, tpm: t.tokens };
        if (ml) result[model].limits = ml;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }
}

module.exports = KeyScorer;
