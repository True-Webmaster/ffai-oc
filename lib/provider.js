/**
 * Provider — encapsulates all per-provider key pool state.
 *
 * Manages key rotation (round-robin or scored), cooldowns, circuit breakers,
 * and per-key/per-day stats recording. Provider-agnostic: no HTTP, no proxy,
 * no upstream URLs.
 *
 * This is the acquire/release interface for FFAI consumers.
 */
const KeyScorer = require("./key-scorer");
const LatencyTracker = require("./latency-tracker");
const { buildKeyIds } = require("./utils");
const { msUntilDailyReset } = require("./free-tier");
const https = require("https");
const http = require("http");

const DEFAULTS = {
  auth_scheme: "bearer",
  auth_header: "authorization",
  auth_query: "key",
  default_cooldown: 60,
  max_cooldown: 300,
  retryable_statuses: [429, 500, 502, 503],
  cb_threshold: 0,
  cb_window: 60000,
  cb_cooldown: 120000,
  rpm_limit: 0,
  tpm_limit: 0,
  rpd_limit: 0,
  key_cb_threshold: 3,
  key_cb_cooldown: 120000,
};

class Provider {
  /**
   * @param {string} name     - Unique provider name (e.g., "gemini", "groq")
   * @param {object} config   - Provider configuration
   * @param {string[]} config.keys          - API keys (already resolved, NOT an env var name)
   * @param {string}   [config.auth_scheme] - "bearer" | "header" | "query" | "none"
   * @param {string}   [config.auth_header] - Custom auth header name (if auth_scheme=header)
   * @param {number}   [config.rpm_limit]   - Requests/minute limit per key
   * @param {number}   [config.tpm_limit]   - Tokens/minute limit per key
   * @param {number}   [config.rpd_limit]   - Requests/day limit per key
   * @param {number}   [config.key_cb_threshold] - Consecutive errors for per-key CB
   * @param {number}   [config.key_cb_cooldown]  - Per-key CB cooldown (ms)
   * @param {number}   [config.cb_threshold]     - Global CB error threshold
   * @param {number}   [config.cb_window]        - Global CB error window (ms)
   * @param {number}   [config.cb_cooldown]      - Global CB cooldown (ms)
   * @param {number}   [config.default_cooldown] - Default 429 cooldown (seconds)
   * @param {number}   [config.max_cooldown]     - Maximum cooldown cap (seconds)
   * @param {number[]} [config.retryable_statuses]
   * @param {object}   [config.logger]
   */
  constructor(name, config) {
    if (!name || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      throw new Error(`Provider name "${name}" must be lowercase alphanumeric (hyphens/underscores ok)`);
    }
    if (!config || typeof config !== "object") {
      throw new Error(`Provider "${name}" — config must be an object`);
    }

    this.name = name;
    this.authScheme = (config.auth_scheme || DEFAULTS.auth_scheme).toLowerCase();
    this.authHeader = (config.auth_header || DEFAULTS.auth_header).toLowerCase();
    this.authQuery = config.auth_query || DEFAULTS.auth_query;
    this.defaultCooldown = config.default_cooldown ?? DEFAULTS.default_cooldown;
    this.maxCooldown = config.max_cooldown ?? DEFAULTS.max_cooldown;
    this.retryableStatuses = config.retryable_statuses || DEFAULTS.retryable_statuses;
    this.cbThreshold = config.cb_threshold ?? DEFAULTS.cb_threshold;
    this.cbWindow = config.cb_window ?? DEFAULTS.cb_window;
    this.cbCooldown = config.cb_cooldown ?? DEFAULTS.cb_cooldown;
    this.logger = config.logger || console;
    this.maxOutputTokens = config.max_output_tokens ?? 0;

    // Rate limit config
    this.rpmLimit = config.rpm_limit ?? DEFAULTS.rpm_limit;
    this.tpmLimit = config.tpm_limit ?? DEFAULTS.tpm_limit;
    this.rpdLimit = config.rpd_limit ?? DEFAULTS.rpd_limit;
    this.keyCbThreshold = config.key_cb_threshold ?? DEFAULTS.key_cb_threshold;
    this.keyCbCooldown = config.key_cb_cooldown ?? DEFAULTS.key_cb_cooldown;

    // Keys
    this.keys = Array.isArray(config.keys) ? config.keys.filter(Boolean) : [];
    if (!this.keys.length) {
      throw new Error(`Provider "${name}" — no keys provided`);
    }
    if (!["bearer", "query", "header", "none"].includes(this.authScheme)) {
      throw new Error(`Provider "${name}" — auth_scheme must be "bearer", "query", "header", or "none"`);
    }

    // Key display IDs
    this.keyIds = buildKeyIds(this.keys);

    // Rotation state
    this.index = 0;
    this.cooldowns = new Map(); // key → cooldown-until timestamp

    // Global circuit breaker state
    this.cbErrors = [];
    this.cbOpenUntil = 0;
    this._cbEpisodeActive = false;

    // Adaptive retry-after: track claimed vs actual reset times
    // Circular buffer of { claimed, actual } pairs, max 20 samples
    this._retryAfterSamples = [];
    this._retryAfterMaxSamples = 20;
    this._retryAfterMultiplier = 1.0; // learned multiplier (starts at 1.0, shrinks if provider over-claims)
    this._retryAfterLastUpdate = 0; // Fix #13: timestamp of last multiplier update
    this._retryAfterDecayMs = 600000; // 10 min: decay back toward 1.0
    this._cooldownClaimed = new Map(); // key → { claimed, setAt } for adaptive learning

    // Smart key scorer (activates when any rate limit is configured)
    // Latency tracker (always active, zero-cost when idle)
    this.latency = new LatencyTracker();

    this.tpdLimit = config.tpd_limit ?? 0; // Fix #7: tokens per day
    this.maxConcurrent = config.max_concurrent ?? 0; // Fix #17

    // Per-error-type retry counts (configurable via config.json)
    this._maxRetries429 = config.max_retries_429 ?? 3;
    this._maxRetriesNetwork = config.max_retries_network ?? 2;
    this._maxRetries5xx = config.max_retries_5xx ?? 2;

    // Invalid key hard-break duration
    this._invalidKeyBreakMs = config.invalid_key_break_ms ?? 0; // 0 = use default formula

    this.scorer = (this.rpmLimit || this.tpmLimit || this.rpdLimit || this.tpdLimit || this.maxConcurrent)
      ? new KeyScorer({
          keys: this.keys,
          keyId: k => this.keyId(k),
          getCooldown: k => this.cooldowns.get(k) || 0,
          name: this.name,
          rpmLimit: this.rpmLimit,
          tpmLimit: this.tpmLimit,
          rpdLimit: this.rpdLimit,
          tpdLimit: this.tpdLimit,
          maxConcurrent: this.maxConcurrent,
          keyCbThreshold: this.keyCbThreshold,
          keyCbCooldown: this.keyCbCooldown,
          modelLimits: config.model_limits || {},
          modelAliases: config.model_aliases || {},
          latencyTracker: this.latency,
          invalidKeyBreakMs: this._invalidKeyBreakMs,
          cbFailRate: config.cb_fail_rate ?? 0,
          cbMinRequests: config.cb_min_requests ?? 0,
          cbMaxBackoff: config.cb_max_backoff ?? 8,
          logger: this.logger,
        })
      : null;

    // Thought signature cache for Gemini 3 tool calling
    // Maps tool_call.id → { signature, ts } with TTL-based eviction
    this._thoughtSigCache = new Map();
    this._thoughtSigMaxSize = 500;
    this._thoughtSigTtl = 300000; // 5 min

    if (this.scorer) {
      this.logger.log(`[ffai:${name}] Smart scoring enabled: rpm=${this.rpmLimit || "inf"} tpm=${this.tpmLimit || "inf"} rpd=${this.rpdLimit || "inf"}`);
    }
  }

  /** Get display ID for a key. */
  keyId(k) {
    return this.keyIds.get(k) || "..." + k.slice(-4);
  }

  // ── Acquire / Release API ──────────────────────────────────────────────────

  /**
   * Acquire the best available key for a request.
   *
   * @param {string|null} [model=null]    - Model name for per-model limit checking
   * @param {number}      [inputTokens=0] - Estimated input tokens for capacity check
   * @returns {string|null} API key, or null if all keys exhausted
   */
  acquire(model = null, inputTokens = 0) {
    if (this.cbIsOpen()) return null;

    // Smart scoring path
    if (this.scorer) return this.scorer.selectKey(model, inputTokens);

    // Fallback: round-robin
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const candidate = this.keys[(this.index + i) % this.keys.length];
      if ((this.cooldowns.get(candidate) || 0) < now) {
        this.index = (this.index + i + 1) % this.keys.length;
        return candidate;
      }
    }
    return null;
  }

  /**
   * Release a key after a request completes. Reports the outcome.
   *
   * @param {string} key          - The key that was used
   * @param {object} outcome
   * @param {boolean} outcome.success        - Whether the request succeeded
   * @param {number}  [outcome.statusCode]   - HTTP status code
   * @param {number}  [outcome.inputTokens]  - Estimated input tokens
   * @param {number}  [outcome.outputTokens] - Output tokens from response
   * @param {string}  [outcome.model]        - Model name for per-model tracking
   * @param {string}  [outcome.retryAfter]   - Retry-After header value (for 429s)
   * @param {number}  [outcome.latencyMs]    - Request duration in milliseconds
   */
  release(key, outcome) {
    if (!outcome || typeof outcome !== "object") {
      this.logger.warn(`[ffai:${this.name}] release: missing/invalid outcome, treating as failed`);
      outcome = { success: false };
    }

    // Record latency with optional TTFT and per-token normalization
    if (outcome.latencyMs != null) {
      this.latency.record(this.keyId(key), outcome.latencyMs, {
        ttftMs: outcome.ttftMs,
        completionTokens: outcome.outputTokens,
        model: outcome.model,
      });
    }

    const model = outcome.model || null;

    // Fix #9: only count in rate windows for successful requests and 429s
    // 5xx/network errors didn't consume upstream quota
    const countInWindow = outcome.success || outcome.statusCode === 429;

    // Always record request in scorer (decrements pending counter)
    if (this.scorer) {
      this.scorer.recordRequest(key, outcome.inputTokens || 0, model, countInWindow);
      if (outcome.outputTokens) {
        this.scorer.recordResponse(key, outcome.outputTokens, model);
      }
    }

    if (outcome.success) {
      if (this.scorer) this.scorer.recordSuccess(key);
      this.cbRecordSuccess();
      // Adaptive retry-after: learn if this key was in cooldown
      this._learnRetryAfter(key);
    } else {
      if (this.scorer) this.scorer.recordError(key, outcome.statusCode);
      this.cbRecordError();

      // Cooldown on rate limit — pass parsed 429 context for smart cooldowns
      if (outcome.statusCode === 429) {
        this.cooldownKey(key, outcome.retryAfter, outcome.errorContext);
      }
    }

    // Ingest rate limit headers for adaptive learning
    if (this.scorer && outcome.rateLimitHeaders) {
      this.scorer.ingestRateLimitHeaders(key, outcome.rateLimitHeaders);
    }
  }

  /**
   * Pre-flight capacity check for a key.
   * Returns null if scorer is not active.
   * @param {string} key
   * @param {string|null} [model]
   * @param {number} [estimatedTokens]
   * @returns {{ ok: boolean, rpmRemaining: number, tpmRemaining: number, rpdRemaining: number }|null}
   */
  preflightCheck(key, model, estimatedTokens) {
    if (!this.scorer) return null;
    return this.scorer.preflightCheck(key, model, estimatedTokens);
  }

  /**
   * Check if a status code is retryable for this provider.
   * @param {number} status
   * @returns {boolean}
   */
  isRetryable(status) {
    return this.retryableStatuses.includes(status);
  }

  /**
   * Get max retries for a given status code / error type.
   * Exception-type retry policies: different errors deserve different retry counts.
   * @param {number} statusCode - HTTP status code (0 for network/timeout errors)
   * @returns {number} Maximum retries for this error type
   */
  maxRetriesFor(statusCode) {
    if (statusCode === 401 || statusCode === 403) return 0; // Auth: never retry
    if (statusCode === 429) return this._maxRetries429;      // Rate limit: retry aggressively
    if (statusCode === 0) return this._maxRetriesNetwork;    // Timeout/network: retry cautiously
    if (statusCode >= 500) return this._maxRetries5xx;       // Server errors: retry cautiously
    return 0;                                                // 4xx (other): don't retry
  }

  // ── Cooldown ─────────────────────────────────────────────────────────────────

  /**
   * Cooldown a key after a 429.
   * @param {string} key
   * @param {string} [retryAfterHeader] - Retry-After header value
   * @param {object} [context] - Optional context from 429 response parsing
   * @param {boolean} [context.dailyExhausted] - True if daily quota is depleted
   * @param {number} [context.parsedRetryMs] - Pre-parsed retry delay in ms (from provider-specific parsing)
   */
  cooldownKey(key, retryAfterHeader, context) {
    // Check if daily quota is exhausted — cooldown until reset instead of short cooldown
    if (context?.dailyExhausted) {
      const resetMs = msUntilDailyReset(this.name);
      if (resetMs && resetMs > 0) {
        const resetSecs = Math.ceil(resetMs / 1000);
        this.cooldowns.set(key, Date.now() + resetMs);
        this.logger.log(`[ffai:${this.name}] ${this.keyId(key)} daily quota exhausted — cooling until reset (${resetSecs}s)`);
        return;
      }
    }

    // Use pre-parsed retry delay from provider-specific 429 parser if available
    let raw;
    if (context?.parsedRetryMs > 0) {
      raw = Math.ceil(context.parsedRetryMs / 1000);
    } else {
      const parsed = parseInt(retryAfterHeader, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        // Retry-After is always in seconds per HTTP spec (RFC 7231 §7.1.3).
        // Some non-standard APIs send retry-after-ms in a separate header —
        // that's handled by parsedRetryMs above. Don't guess based on magnitude.
        raw = parsed;
      } else if (retryAfterHeader) {
        const httpDate = Date.parse(retryAfterHeader);
        raw = Number.isFinite(httpDate) ? Math.max(0, Math.ceil((httpDate - Date.now()) / 1000)) : this.defaultCooldown;
      } else {
        raw = this.defaultCooldown;
      }
    }
    const claimedSecs = Math.max(0, Math.min(raw, this.maxCooldown));

    // Fix #13: decay multiplier back toward 1.0 over time
    if (this._retryAfterMultiplier < 1.0 && this._retryAfterLastUpdate > 0) {
      const now = Date.now();
      const elapsed = now - this._retryAfterLastUpdate;
      if (elapsed > this._retryAfterDecayMs) {
        const periods = Math.floor(elapsed / this._retryAfterDecayMs);
        for (let i = 0; i < periods && this._retryAfterMultiplier < 1.0; i++) {
          this._retryAfterMultiplier = Math.min(1.0, this._retryAfterMultiplier + 0.1);
        }
        // Advance timestamp so elapsed periods aren't counted again
        this._retryAfterLastUpdate = now;
      }
    }

    // Apply adaptive multiplier (if we've learned the provider over-claims)
    const adaptedSecs = Math.max(1, Math.round(claimedSecs * this._retryAfterMultiplier));
    this.cooldowns.set(key, Date.now() + adaptedSecs * 1000);

    // Store claimed time for adaptive learning (we'll measure actual on next success)
    this._cooldownClaimed.set(key, { claimed: claimedSecs, setAt: Date.now() });

    const suffix = adaptedSecs !== claimedSecs ? ` (adapted from ${claimedSecs}s, multiplier ${this._retryAfterMultiplier.toFixed(2)})` : "";
    this.logger.log(`[ffai:${this.name}] ${this.keyId(key)} rate-limited, cooling ${adaptedSecs}s${suffix}`);
  }

  /**
   * Learn from actual cooldown durations. Called when a key that was in cooldown
   * successfully handles a request — the actual wait was shorter than claimed.
   * @param {string} key
   */
  _learnRetryAfter(key) {
    if (!this._cooldownClaimed) return;
    const entry = this._cooldownClaimed.get(key);
    if (!entry) return;
    this._cooldownClaimed.delete(key);

    const actualMs = Date.now() - entry.setAt;
    const actualSecs = actualMs / 1000;
    const claimed = entry.claimed;

    // Only learn when we had a meaningful claimed value
    if (claimed < 2) return;

    // Discard idle-polluted samples: if actual is >3x the claimed time, the key
    // was likely idle (no traffic) rather than actively testing the cooldown.
    // Learning from these would skew the multiplier upward.
    if (actualSecs > claimed * 3) return;

    this._retryAfterSamples.push({ claimed, actual: actualSecs });
    if (this._retryAfterSamples.length > this._retryAfterMaxSamples) {
      this._retryAfterSamples.shift();
    }

    // Recompute multiplier from all samples
    if (this._retryAfterSamples.length >= 3) {
      let sumRatio = 0;
      for (const s of this._retryAfterSamples) {
        sumRatio += s.actual / s.claimed;
      }
      const avgRatio = sumRatio / this._retryAfterSamples.length;
      // Clamp: never go below 0.3x or above 1.0x the claimed time
      const newMultiplier = Math.max(0.3, Math.min(1.0, avgRatio));
      if (Math.abs(newMultiplier - this._retryAfterMultiplier) > 0.05) {
        this.logger.log(`[ffai:${this.name}] adaptive retry-after: multiplier ${this._retryAfterMultiplier.toFixed(2)} -> ${newMultiplier.toFixed(2)} (${this._retryAfterSamples.length} samples)`);
        this._retryAfterMultiplier = newMultiplier;
        this._retryAfterLastUpdate = Date.now(); // Fix #13
      }
    }
  }

  // ── Status ───────────────────────────────────────────────────────────────────

  /**
   * Get milliseconds until the soonest key becomes available.
   * Returns 0 if a key is already available, or the shortest cooldown/CB remaining.
   * Returns Infinity if no key will become available (all permanently broken).
   * @returns {number}
   */
  soonestAvailableMs() {
    const now = Date.now();
    let soonest = Infinity;
    let anyAvailable = false;

    for (const k of this.keys) {
      const cooldownUntil = this.cooldowns.get(k) || 0;
      const cbUntil = this.scorer ? (this.scorer.keyCbUntil.get(k) || 0) : 0;
      const blockUntil = Math.max(cooldownUntil, cbUntil);

      if (blockUntil <= now) {
        anyAvailable = true;
        break;
      }
      soonest = Math.min(soonest, blockUntil - now);
    }

    return anyAvailable ? 0 : soonest;
  }

  /**
   * Get aggregate key availability.
   * @returns {{ total: number, available: number, coolingDown: number, keyCbOpen: number }}
   */
  keyStatus() {
    const now = Date.now();
    let cooling = 0, keyCbOpen = 0, selectable = 0;
    for (const k of this.keys) {
      const inCooldown = (this.cooldowns.get(k) || 0) > now;
      const inKeyCb = this.scorer && (this.scorer.keyCbUntil.get(k) || 0) > now;
      if (inCooldown) cooling++;
      if (inKeyCb) keyCbOpen++;
      if (!inCooldown && !inKeyCb) selectable++;
    }
    return { total: this.keys.length, available: selectable, coolingDown: cooling, keyCbOpen };
  }

  /**
   * Get per-key detailed statuses (only available with smart scoring).
   * Includes per-key latency stats when available.
   * @returns {Object|null}
   */
  keyDetails() {
    const base = this.scorer ? this.scorer.keyStatuses() : null;
    if (!base) return null;

    // Merge per-key latency into scorer output
    const latencyByKey = this.latency.allKeyStats();
    for (const [kid, stats] of Object.entries(base)) {
      stats.latency = latencyByKey[kid] || null;
    }
    return base;
  }

  /**
   * Get provider-level aggregate latency stats.
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  latencyStats() {
    return this.latency.providerStats();
  }

  // ── Thought Signatures (Gemini 3) ────────────────────────────────────────────

  /**
   * Cache a thought signature from a Gemini 3 tool_call response.
   * @param {string} toolCallId
   * @param {string} signature
   */
  cacheThoughtSignature(toolCallId, signature) {
    if (!toolCallId || !signature) return;
    // FIFO eviction at capacity
    if (this._thoughtSigCache.size >= this._thoughtSigMaxSize) {
      const oldest = this._thoughtSigCache.keys().next().value;
      this._thoughtSigCache.delete(oldest);
    }
    this._thoughtSigCache.set(toolCallId, { signature, ts: Date.now() });
  }

  /**
   * Retrieve a cached thought signature (returns null if expired or missing).
   * @param {string} toolCallId
   * @returns {string|null}
   */
  getThoughtSignature(toolCallId) {
    if (!toolCallId) return null;
    const entry = this._thoughtSigCache.get(toolCallId);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._thoughtSigTtl) {
      this._thoughtSigCache.delete(toolCallId);
      return null;
    }
    return entry.signature;
  }

  /**
   * Extract and cache thought signatures from a parsed response object.
   * Works on both streaming delta chunks and non-streaming message responses.
   * @param {object} parsed - Parsed JSON from SSE chunk or response body
   */
  extractThoughtSignatures(parsed) {
    const choices = parsed?.choices;
    if (!Array.isArray(choices)) return;
    for (const choice of choices) {
      const toolCalls = choice?.delta?.tool_calls || choice?.message?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        const sig = tc?.extra_content?.google?.thought_signature;
        if (sig && tc.id) {
          this.cacheThoughtSignature(tc.id, sig);
          this.logger.log(`[ffai:${this.name}] cached thought_signature for tool_call ${tc.id.slice(0, 12)}…`);
        }
      }
    }
  }

  /**
   * Inject cached thought signatures into outbound request messages.
   * For assistant messages with tool_calls that lack signatures and have no
   * cached signature available, compacts the message to plain text (Gemini 3
   * rejects tool_calls missing signatures in conversation history).
   *
   * @param {Array} messages - The messages array from the request body
   * @returns {boolean} Whether any modifications were made
   */
  injectThoughtSignatures(messages) {
    if (!Array.isArray(messages)) return false;
    let modified = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

      let allHaveSig = true;
      for (const tc of msg.tool_calls) {
        if (!tc.id) { allHaveSig = false; continue; }
        if (!tc.extra_content?.google?.thought_signature) {
          const sig = this.getThoughtSignature(tc.id);
          if (sig) {
            if (!tc.extra_content) tc.extra_content = {};
            if (!tc.extra_content.google) tc.extra_content.google = {};
            tc.extra_content.google.thought_signature = sig;
            modified = true;
          } else {
            allHaveSig = false;
          }
        }
      }

      // If any tool_calls still lack signatures, compact to plain text
      if (!allHaveSig) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name || "tool").join(", ");
        const textContent = msg.content || "";
        messages[i] = {
          role: "assistant",
          content: textContent || `[Used tools: ${toolNames}]`,
        };
        modified = true;

        // Remove following tool result messages (they reference tool_calls
        // that no longer exist after compaction)
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          messages.splice(j, 1);
          modified = true;
        }

        this.logger.log(`[ffai:${this.name}] compacted tool_call round at msg[${i}] (${toolNames}) — no cached signatures`);
      }
    }

    return modified;
  }

  // ── Key Validation ──────────────────────────────────────────────────────────

  /**
   * Validate a key by making a lightweight API call.
   * Uses the provider's upstream URL and auth scheme to send a minimal request.
   *
   * @param {string} key
   * @param {string} upstreamUrl - Provider's upstream base URL
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{valid: boolean, status: number, error?: string}>}
   */
  validateKey(key, upstreamUrl, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!upstreamUrl) return resolve({ valid: false, status: 0, error: "no upstream_url" });

      let url;
      try {
        const base = new URL(upstreamUrl);
        url = new URL(base.pathname.replace(/\/+$/, "") + "/models", base.origin);
      } catch {
        return resolve({ valid: false, status: 0, error: "invalid upstream_url" });
      }

      const headers = { "accept": "application/json", "user-agent": "ffai-validator/1.0" };
      if (this.authScheme === "bearer") {
        headers.authorization = `Bearer ${key}`;
      } else if (this.authScheme === "header") {
        headers[this.authHeader] = key;
      } else if (this.authScheme === "query") {
        url.searchParams.set(this.authQuery || "key", key);
      }

      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers,
        timeout: timeoutMs,
      }, (res) => {
        res.resume(); // drain body
        if (res.statusCode === 401 || res.statusCode === 403) {
          resolve({ valid: false, status: res.statusCode, error: "auth failed" });
        } else {
          // 200, 404, even 429 means the key is accepted by the API
          resolve({ valid: true, status: res.statusCode });
        }
      });
      req.on("error", (err) => resolve({ valid: false, status: 0, error: err.message }));
      req.on("timeout", () => { req.destroy(); resolve({ valid: false, status: 0, error: "timeout" }); });
      req.end();
    });
  }

  /**
   * Mark a key as invalid by tripping its per-key circuit breaker.
   * @param {string} key
   */
  /**
   * Mark a key as invalid. Fix #8: uses long duration (30 min minimum).
   * @param {string} key
   */
  markKeyInvalid(key) {
    const hardBreakMs = this._invalidKeyBreakMs > 0
      ? this._invalidKeyBreakMs
      : Math.max(this.keyCbCooldown * 10, 1800000); // 30 min minimum default
    if (this.scorer) {
      // Trip the per-key CB with long duration
      this.scorer.keyCbUntil.set(key, Date.now() + hardBreakMs);
      this.scorer.consecutiveErrors.set(key, this.keyCbThreshold);
      this.scorer.keyCbBackoff.set(key, 8); // Start at max backoff
      this.logger.warn(`[ffai:${this.name}] ${this.keyId(key)} marked invalid — circuit-broken for ${hardBreakMs / 1000}s`);
    } else {
      // Without scorer, put key in extended cooldown
      this.cooldowns.set(key, Date.now() + hardBreakMs);
      this.logger.warn(`[ffai:${this.name}] ${this.keyId(key)} marked invalid — cooldown ${hardBreakMs / 1000}s`);
    }
  }

  // ── Circuit Breaker ──────────────────────────────────────────────────────────

  cbRecordError() {
    if (!this.cbThreshold) return;
    if (this.cbOpenUntil > Date.now()) return;
    const now = Date.now();
    this.cbErrors.push(now);
    this.cbErrors = this.cbErrors.filter(t => now - t < this.cbWindow);
    if (this.cbErrors.length >= this.cbThreshold) {
      this.cbOpenUntil = now + this.cbCooldown;
      this.cbErrors = [];
      this.logger.warn(`[ffai:${this.name}] CIRCUIT OPEN — blocking requests for ${this.cbCooldown / 1000}s`);
    }
  }

  cbRecordSuccess() {
    if (!this.cbThreshold) return;
    this.cbErrors = [];
  }

  cbIsOpen() {
    const now = Date.now();

    // Error-count-based global CB (honoured in both scorer and non-scorer modes).
    // When cbThreshold > 0 and enough errors pile up in cbWindow, cbOpenUntil is set
    // by cbRecordError(). This catches shared-dependency failures (e.g., entire API down)
    // that individual per-key CBs would be slow to detect.
    if (this.cbThreshold && now < this.cbOpenUntil) return true;
    if (this.cbThreshold && this.cbOpenUntil > 0 && now >= this.cbOpenUntil) {
      this.cbOpenUntil = 0;
      this.logger.log(`[ffai:${this.name}] Global circuit breaker closed — resuming`);
    }

    // With scorer: also check whether ALL keys are individually broken
    if (this.scorer) {
      if (this.scorer.isAllKeysCircuitOpen()) {
        if (!this._cbEpisodeActive) {
          this._cbEpisodeActive = true;
          this.cbOpenUntil = now + this.cbCooldown;
          this.logger.warn(`[ffai:${this.name}] ALL KEYS CIRCUIT OPEN — blocking for ${this.cbCooldown / 1000}s`);
        }
        return now < this.cbOpenUntil;
      }
      if (this._cbEpisodeActive) {
        this._cbEpisodeActive = false;
        this.cbOpenUntil = 0;
        this.logger.log(`[ffai:${this.name}] All-keys circuit breaker closed — resuming`);
      }
      return false;
    }

    // Non-scorer fallback already handled by the global CB check above
    return false;
  }
}

module.exports = Provider;
