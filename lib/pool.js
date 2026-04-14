/**
 * Pool — the top-level rotation engine.
 *
 * Manages multiple Providers, routes acquire/release by provider name,
 * exposes health/stats, and handles lifecycle (startup, shutdown).
 *
 * This is FFAI's public API surface.
 *
 * @example
 *   const pool = new Pool({ providers: config, statsFile: "./data/stats.json" });
 *   const key = pool.acquire("gemini");
 *   // ... use key to call the API ...
 *   pool.release("gemini", key, { success: true, inputTokens: 500 });
 */
const Provider = require("./provider");
const Stats = require("./stats");
const Alerter = require("./alerter");
const { applyFreeTierDefaults } = require("./free-tier");
const path = require("path");

class Pool {
  /**
   * @param {object} opts
   * @param {Object.<string, object>} opts.providers  - Provider configs keyed by name
   * @param {string}  [opts.statsFile]       - Path to stats persistence file
   * @param {number}  [opts.statsFlushInterval] - Flush interval ms (default: 60000)
   * @param {number}  [opts.statsRetentionDays] - Days to retain (default: 7)
   * @param {object}  [opts.logger]          - Logger with .log(), .warn(), .error()
   * @param {object}  [opts.deprecationTracker] - Optional DeprecationTracker instance
   */
  constructor(opts) {
    this.logger = opts.logger || console;
    this.deprecationTracker = opts.deprecationTracker || null;
    this.discovery = null; // set by serve.js after ModelDiscovery init
    this.alerter = new Alerter({
      webhookUrl: opts.alertWebhookUrl || "",
      throttleMs: opts.alertThrottleMs,
      timeoutMs: opts.alertTimeoutMs,
      eventTtls: opts.alertEventTtls || {},
      logger: this.logger,
    });
    this._providers = new Map();

    // Initialize stats
    this.stats = new Stats({
      file: opts.statsFile || path.join(process.cwd(), "data", "stats.json"),
      flushInterval: opts.statsFlushInterval ?? 60000,
      retentionDays: opts.statsRetentionDays ?? 7,
    });

    // Pricing for cost tracking ($ per request, from config)
    this._pricing = opts.pricing || {};

    // Initialize providers and build family map
    this._families = new Map(); // familyName → Set of providerNames
    this._providerFamily = new Map(); // providerName → familyName
    this._configFingerprints = new Map(); // providerName → config fingerprint string

    for (const [name, config] of Object.entries(opts.providers || {})) {
      try {
        const provConfig = { ...config, logger: this.logger };
        // Auto-apply free-tier defaults if no explicit limits configured
        applyFreeTierDefaults(name, provConfig);
        this._providers.set(name, new Provider(name, provConfig));
        this._configFingerprints.set(name, this._configFingerprint(config));
        this.logger.log(`[ffai:pool] Loaded provider "${name}" with ${(config.keys || []).length} key(s)`);

        // Family assignment: explicit family or singleton auto-family
        const familyName = config.family || name;
        this._providerFamily.set(name, familyName);
        if (!this._families.has(familyName)) {
          this._families.set(familyName, new Set());
        }
        this._families.get(familyName).add(name);
      } catch (err) {
        this.logger.error(`[ffai:pool] Failed to load provider "${name}": ${err.message} — skipping`);
      }
    }

    if (this._providers.size === 0) {
      this.logger.warn("[ffai:pool] WARNING: No providers configured");
    }
  }

  /**
   * Acquire a key from a provider's pool.
   *
   * Returns null when all keys are exhausted. The bridge returns 429
   * ("All keys rate limited") in this case — the same signal OpenClaw
   * already handles, letting it fall back to its own provider config.
   *
   * @param {string} providerName
   * @param {object} [opts={}]
   * @param {string|null} [opts.model]       - Model name for per-model limit checking
   * @param {number}      [opts.inputTokens] - Estimated input tokens for capacity check
   * @returns {{ key: string, provider: string } | null} - Null if all keys exhausted
   */
  acquire(providerName, opts = {}) {
    const prov = this._providers.get(providerName);
    if (!prov) {
      this.logger.warn(`[ffai:pool] acquire: unknown provider "${providerName}"`);
      return null;
    }

    const key = prov.acquire(opts.model || null, opts.inputTokens || 0);
    if (!key) {
      if (prov.cbIsOpen()) {
        this.stats.recordCircuitBreak(providerName);
        this.alerter.fire("circuit_open", { provider: providerName, message: `${providerName}: circuit breaker open` });
      } else {
        this.stats.recordAllKeysExhausted(providerName);
        this.alerter.fire("all_keys_exhausted", { provider: providerName, message: `${providerName}: all keys exhausted` });
      }
      return null;
    }

    // Record the request in stats
    this.stats.recordRequest(providerName, prov.keyId(key));
    return { key, provider: providerName };
  }

  /**
   * Acquire a key from any provider in a family.
   * Tries providers sorted by available key count (most available first).
   *
   * @param {string} familyName
   * @param {object} [opts={}]
   * @param {string|null} [opts.model]       - Model name for per-model limit checking
   * @param {number}      [opts.inputTokens] - Estimated input tokens for capacity check
   * @returns {{ key: string, provider: string, family: string } | null}
   */
  acquireFromFamily(familyName, opts = {}) {
    const members = this._families.get(familyName);
    if (!members || members.size === 0) {
      this.logger.warn(`[ffai:pool] acquireFromFamily: unknown family "${familyName}"`);
      return null;
    }

    // Sort providers by available key count descending (prefer providers with more capacity)
    const sorted = Array.from(members).sort((a, b) => {
      const provA = this._providers.get(a);
      const provB = this._providers.get(b);
      return provB.keyStatus().available - provA.keyStatus().available;
    });

    // Try each provider quietly — only fire alerts if the entire family is exhausted
    for (const provName of sorted) {
      const prov = this._providers.get(provName);
      if (!prov) continue;

      const key = prov.acquire(opts.model || null, opts.inputTokens || 0);
      if (key) {
        this.stats.recordRequest(provName, prov.keyId(key));
        return { key, provider: provName, family: familyName };
      }
    }

    // Whole family exhausted — fire one alert at the family level
    this.alerter.fire("all_keys_exhausted", {
      provider: familyName,
      message: `${familyName}: all providers in family exhausted`,
    });

    return null;
  }

  /**
   * Get the family grouping: familyName → [providerNames].
   * @returns {Object.<string, string[]>}
   */
  families() {
    const result = {};
    for (const [familyName, members] of this._families) {
      result[familyName] = Array.from(members);
    }
    return result;
  }

  /**
   * Get the family name for a provider.
   * @param {string} providerName
   * @returns {string|undefined}
   */
  providerFamily(providerName) {
    return this._providerFamily.get(providerName);
  }

  /**
   * Release a key back to the pool with outcome reporting.
   *
   * @param {string} providerName
   * @param {string} key
   * @param {object} outcome
   * @param {boolean} outcome.success
   * @param {number}  [outcome.statusCode]
   * @param {number}  [outcome.inputTokens]
   * @param {number}  [outcome.outputTokens]
   * @param {string}  [outcome.retryAfter]
   * @param {number}  [outcome.latencyMs]    - Request duration in milliseconds
   */
  release(providerName, key, outcome) {
    const prov = this._providers.get(providerName);
    if (!prov) return;

    // Guard: missing or malformed outcome
    if (!outcome || typeof outcome !== "object") {
      this.logger.warn(`[ffai:pool] release: missing/invalid outcome for "${providerName}", treating as failed`);
      outcome = { success: false };
    }

    // Guard: key may belong to a previous provider instance after hot-reload
    if (!prov.keys.includes(key)) {
      this.logger.warn(`[ffai:pool] release: key not found in "${providerName}" (likely post-reload), skipping`);
      return;
    }

    // Capture keyId before release — provider state may change during release
    const kid = prov.keyId(key);

    prov.release(key, outcome);

    // Telemetry is secondary — never let it crash the request path
    try {
      // Record latency in daily stats
      if (outcome.latencyMs != null) {
        this.stats.recordLatency(providerName, kid, outcome.latencyMs);
      }

      // Record in stats
      if (!outcome.success) {
        if (outcome.statusCode === 429) {
          this.stats.recordRateLimit(providerName, kid);
        } else {
          this.stats.recordError(providerName, kid);
        }
      }

      // Record tokens and estimated cost
      const inputTokens = outcome.inputTokens || 0;
      const outputTokens = outcome.outputTokens || 0;
      if (inputTokens > 0 || outputTokens > 0) {
        const costRate = this._pricing[providerName] ?? this._pricing.default ?? 0;
        this.stats.recordTokens(providerName, kid, inputTokens, outputTokens, costRate);
      }
    } catch (err) {
      this.logger.warn(`[ffai:pool] release: telemetry error for "${providerName}": ${err.message}`);
    }
  }

  /**
   * Get health status for all providers.
   * Includes family-level rollup.
   * @returns {object}
   */
  health() {
    const providers = {};
    let anyDegraded = false;

    for (const [name, prov] of this._providers) {
      const ks = prov.keyStatus();
      const cbOpen = prov.cbIsOpen();
      const status = (ks.available === 0 || cbOpen) ? "degraded" : "ok";
      if (status === "degraded") anyDegraded = true;

      const entry = {
        status,
        keys: ks,
        circuitBreaker: cbOpen ? "open" : "closed",
        scoring: prov.scorer ? "enabled" : "disabled",
        family: this._providerFamily.get(name),
      };

      // Include latency stats if available
      if (typeof prov.latencyStats === "function") {
        entry.latency = prov.latencyStats();
      }

      providers[name] = entry;
    }

    // Family-level rollup
    const familyHealth = {};
    for (const [familyName, members] of this._families) {
      let familyAvailable = 0;
      let familyTotal = 0;
      let anyMemberOk = false;
      for (const provName of members) {
        const p = providers[provName];
        if (p) {
          familyAvailable += p.keys.available;
          familyTotal += p.keys.total;
          if (p.status === "ok") anyMemberOk = true;
        }
      }
      familyHealth[familyName] = {
        status: anyMemberOk ? "ok" : "degraded",
        providers: Array.from(members),
        keys: { total: familyTotal, available: familyAvailable },
      };
    }

    return {
      status: anyDegraded ? "degraded" : "ok",
      providers,
      families: familyHealth,
      uptime: Date.now() - this.stats.data.startedAt,
    };
  }

  /**
   * Get detailed health (includes per-key scoring info).
   * @returns {object}
   */
  healthDetailed() {
    const base = this.health();
    for (const [name, prov] of this._providers) {
      const details = prov.keyDetails();
      if (details) {
        base.providers[name].perKey = details;
      }
    }
    return base;
  }

  /**
   * Get a provider by name.
   * @param {string} name
   * @returns {Provider|undefined}
   */
  getProvider(name) {
    return this._providers.get(name);
  }

  /** @returns {string[]} All provider names. */
  providerNames() {
    return Array.from(this._providers.keys());
  }

  /**
   * Get utilization ratio for a provider (0.0-1.0).
   * Returns null if scorer is not active.
   * @param {string} providerName
   * @param {string|null} [model=null]
   * @returns {number|null}
   */
  utilization(providerName, model = null) {
    const prov = this._providers.get(providerName);
    if (!prov || !prov.scorer) return null;
    return prov.scorer.utilization(model);
  }

  /** @returns {number} Number of configured providers. */
  get size() {
    return this._providers.size;
  }

  /**
   * Graceful shutdown: flush stats and clean up timers.
   */
  async shutdown() {
    this.stats.stop();
    this.stats.flushSync();
    this.logger.log("[ffai:pool] Shutdown complete");
  }

  /**
   * Validate all keys across all providers by pinging upstream /models.
   * Invalid keys are immediately circuit-broken.
   *
   * @param {Object.<string, string>} upstreamUrls - providerName → upstream base URL
   * @param {number} [timeoutMs=10000]
   * @returns {Promise<{total: number, valid: number, invalid: number, errors: string[]}>}
   */
  async validateKeys(upstreamUrls, timeoutMs = 10000) {
    let total = 0, valid = 0, invalid = 0;
    const errors = [];

    // Collect all validation tasks
    const tasks = [];
    for (const [name, prov] of this._providers) {
      const upstream = upstreamUrls[name];
      if (!upstream) continue;
      for (const key of prov.keys) {
        total++;
        tasks.push({ name, prov, key, upstream });
      }
    }

    // Bounded concurrency — max 5 parallel validation requests
    const CONCURRENCY = 5;
    let i = 0;
    const run = async () => {
      while (i < tasks.length) {
        const idx = i++;
        const { name, prov, key, upstream } = tasks[idx];
        try {
          const result = await prov.validateKey(key, upstream, timeoutMs);
          // Re-resolve the live provider — a reload may have swapped it since validation started
          const liveProv = this._providers.get(name);
          if (result.valid) {
            valid++;
            this.logger.log(`[ffai:pool] ${name}/${prov.keyId(key)} ✓ valid (${result.status})`);
          } else if (result.status === 401 || result.status === 403) {
            // Definitive auth failure — hard-break the key on the LIVE provider only
            invalid++;
            const msg = `${name}/${prov.keyId(key)}: auth failed (${result.status})`;
            errors.push(msg);
            if (liveProv && liveProv.keys.includes(key)) {
              liveProv.markKeyInvalid(key);
            }
            this.logger.warn(`[ffai:pool] ${name}/${prov.keyId(key)} ✗ invalid — ${result.error || result.status}`);
          } else {
            // Network error, timeout, or non-auth failure — inconclusive, don't break the key
            const msg = `${name}/${prov.keyId(key)}: inconclusive — ${result.error || `status ${result.status}`}`;
            errors.push(msg);
            this.logger.warn(`[ffai:pool] ${name}/${prov.keyId(key)} ? inconclusive — ${result.error || result.status} (key NOT disabled)`);
          }
        } catch (err) {
          // Per-key validation must never abort the sweep
          const kid = prov.keyId?.(key) || "???";
          const msg = `${name}/${kid}: validation threw — ${err.message || err}`;
          errors.push(msg);
          this.logger.warn(`[ffai:pool] ${name}/${kid} ! validation error (key NOT disabled): ${err.message || err}`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => run()));
    return { total, valid, invalid, errors };
  }

  /**
   * Build a config fingerprint for a provider config.
   * Used to detect operationally relevant config changes beyond just key sets.
   * @param {object} config
   * @returns {string}
   */
  _configFingerprint(config) {
    // All fields that affect provider behavior — if any change, rebuild
    const fields = {
      keys: (config.keys || []).slice().sort().join(","),
      auth_scheme: config.auth_scheme || "",
      auth_header: config.auth_header || "",
      rpm_limit: config.rpm_limit ?? 0,
      tpm_limit: config.tpm_limit ?? 0,
      rpd_limit: config.rpd_limit ?? 0,
      tpd_limit: config.tpd_limit ?? 0,
      max_concurrent: config.max_concurrent ?? 0,
      default_cooldown: config.default_cooldown ?? 60,
      max_cooldown: config.max_cooldown ?? 300,
      cb_threshold: config.cb_threshold ?? 0,
      cb_window: config.cb_window ?? 60000,
      cb_cooldown: config.cb_cooldown ?? 120000,
      key_cb_threshold: config.key_cb_threshold ?? 3,
      key_cb_cooldown: config.key_cb_cooldown ?? 120000,
      max_output_tokens: config.max_output_tokens ?? 0,
      family: config.family || "",
      model_limits: Pool._canonicalJson(config.model_limits || {}),
      model_aliases: Pool._canonicalJson(config.model_aliases || {}),
    };
    return JSON.stringify(fields);
  }

  /**
   * Hot-reload providers from new config. Preserves stats and alerter.
   * Existing providers with unchanged config fingerprints keep their rotation state.
   * New providers are added, removed providers are dropped.
   *
   * The swap is atomic: all new state is built first, then assigned in one step.
   *
   * @param {Object.<string, object>} providerConfigs - New provider configs
   */
  /**
   * Carry over per-key cooldown/CB state from old provider to new.
   * Only transfers state for keys present in both instances.
   * @param {Provider} oldProv
   * @param {Provider} newProv
   */
  _carryOverKeyState(oldProv, newProv) {
    const now = Date.now();
    const oldKeys = new Set(oldProv.keys);
    let carried = 0;

    for (const key of newProv.keys) {
      if (!oldKeys.has(key)) continue;

      // Carry cooldown timestamps (429 backoff)
      const cooldownUntil = oldProv.cooldowns.get(key);
      if (cooldownUntil && cooldownUntil > now) {
        newProv.cooldowns.set(key, cooldownUntil);
        carried++;
      }

      // Carry per-key circuit breaker state from scorer
      if (oldProv.scorer && newProv.scorer) {
        const cbUntil = oldProv.scorer.keyCbUntil.get(key);
        if (cbUntil && cbUntil > now) {
          newProv.scorer.keyCbUntil.set(key, cbUntil);
          newProv.scorer.keyCbBackoff.set(key, oldProv.scorer.keyCbBackoff.get(key) || 1);
          newProv.scorer.consecutiveErrors.set(key, oldProv.scorer.consecutiveErrors.get(key) || 0);
        }

        // Carry learned limits (they're expensive to re-learn)
        const learnedRpm = oldProv.scorer.learnedRpm.get(key);
        if (learnedRpm) {
          newProv.scorer.learnedRpm.set(key, learnedRpm);
          newProv.scorer.learnedRpmTs.set(key, oldProv.scorer.learnedRpmTs.get(key) || now);
        }
        const learnedTpm = oldProv.scorer.learnedTpm.get(key);
        if (learnedTpm) {
          newProv.scorer.learnedTpm.set(key, learnedTpm);
          newProv.scorer.learnedTpmTs.set(key, oldProv.scorer.learnedTpmTs.get(key) || now);
        }
        const learnedRpd = oldProv.scorer.learnedRpd.get(key);
        if (learnedRpd) {
          newProv.scorer.learnedRpd.set(key, learnedRpd);
          newProv.scorer.learnedRpdTs.set(key, oldProv.scorer.learnedRpdTs.get(key) || now);
        }
      }
    }

    // Carry global CB state
    if (oldProv.cbOpenUntil > now) {
      newProv.cbOpenUntil = oldProv.cbOpenUntil;
      newProv.cbErrors = oldProv.cbErrors.slice();
    }

    // Carry adaptive retry-after multiplier
    if (oldProv._retryAfterMultiplier !== 1.0) {
      newProv._retryAfterMultiplier = oldProv._retryAfterMultiplier;
      newProv._retryAfterLastUpdate = oldProv._retryAfterLastUpdate;
      newProv._retryAfterSamples = oldProv._retryAfterSamples.slice();
    }

    if (carried > 0) {
      this.logger.log(`[ffai:pool] Carried over protection state for ${carried} key(s) in "${newProv.name}"`);
    }
  }

  reload(providerConfigs) {
    const newProviders = new Map();
    const newFamilies = new Map();
    const newProviderFamily = new Map();

    for (const [name, config] of Object.entries(providerConfigs || {})) {
      try {
        const provConfig = { ...config, logger: this.logger };
        applyFreeTierDefaults(name, provConfig);

        // Reuse existing provider if full config fingerprint hasn't changed
        const existing = this._providers.get(name);
        if (existing) {
          const oldFp = this._configFingerprints?.get(name);
          const newFp = this._configFingerprint(config);
          if (oldFp && oldFp === newFp) {
            newProviders.set(name, existing);
            this.logger.log(`[ffai:pool] Reload: "${name}" unchanged, keeping state`);
          } else {
            const rebuilt = new Provider(name, provConfig);
            // Carry over per-key protection state for keys that exist in both old and new.
            // This prevents a config change (e.g. rpm_limit tweak) from clearing active
            // cooldowns or circuit breakers, which would cause immediate re-429s.
            this._carryOverKeyState(existing, rebuilt);
            newProviders.set(name, rebuilt);
            this.logger.log(`[ffai:pool] Reload: "${name}" config changed, rebuilding (carried over key state)`);
          }
        } else {
          newProviders.set(name, new Provider(name, provConfig));
          this.logger.log(`[ffai:pool] Reload: "${name}" added with ${(config.keys || []).length} key(s)`);
        }

        const familyName = config.family || name;
        newProviderFamily.set(name, familyName);
        if (!newFamilies.has(familyName)) newFamilies.set(familyName, new Set());
        newFamilies.get(familyName).add(name);
      } catch (err) {
        // Keep last-known-good instance if available, skip otherwise
        const existing = this._providers.get(name);
        if (existing) {
          newProviders.set(name, existing);
          const familyName = config.family || name;
          newProviderFamily.set(name, familyName);
          if (!newFamilies.has(familyName)) newFamilies.set(familyName, new Set());
          newFamilies.get(familyName).add(name);
          this.logger.error(`[ffai:pool] Reload: "${name}" failed (${err.message}) — keeping previous instance`);
        } else {
          this.logger.error(`[ffai:pool] Reload: "${name}" failed (${err.message}) — skipping`);
        }
      }
    }

    // Log removed providers
    for (const name of this._providers.keys()) {
      if (!newProviders.has(name)) {
        this.logger.log(`[ffai:pool] Reload: "${name}" removed`);
      }
    }

    // Build new fingerprint cache — only for providers that were actually accepted.
    // Failed rebuilds that fell back to last-known-good keep their old fingerprint
    // so the next reload with the same config will retry the rebuild.
    const newFingerprints = new Map();
    for (const [name, config] of Object.entries(providerConfigs || {})) {
      if (newProviders.has(name)) {
        const prov = newProviders.get(name);
        const existing = this._providers.get(name);
        if (prov === existing && this._configFingerprints?.has(name)) {
          // Kept last-known-good after failed rebuild — preserve old fingerprint
          newFingerprints.set(name, this._configFingerprints.get(name));
        } else {
          newFingerprints.set(name, this._configFingerprint(config));
        }
      }
    }

    // Atomic swap — all references updated together
    this._providers = newProviders;
    this._families = newFamilies;
    this._providerFamily = newProviderFamily;
    this._configFingerprints = newFingerprints;
    this.logger.log(`[ffai:pool] Reload complete: ${newProviders.size} provider(s)`);
  }
}

/** Order-insensitive JSON serialization for nested config objects. */
Pool._canonicalJson = function _canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(_canonicalJson).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + _canonicalJson(obj[k])).join(",") + "}";
};

module.exports = Pool;
