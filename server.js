const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ── Global Config (env vars) ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8002", 10);
const BIND_ADDRESS = (process.env.BIND_ADDRESS || "127.0.0.1").trim();
const PROXY_KEY = (process.env.PROXY_KEY || "").trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();
const ALERT_TIMEOUT = parseInt(process.env.ALERT_TIMEOUT || "5000", 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || "5000", 10);
const STATS_FILE = process.env.STATS_FILE || path.join(".", "data", "stats.json");
const STATS_FLUSH_INTERVAL = parseInt(process.env.STATS_FLUSH_INTERVAL || "60000", 10);
const STATS_RETENTION_DAYS = parseInt(process.env.STATS_RETENTION_DAYS || "7", 10);
const PROVIDERS_FILE = process.env.PROVIDERS_FILE || path.join(".", "providers.json");

// Global defaults — providers inherit these unless they override
const DEFAULTS = {
  mode: "proxy",
  auth_scheme: "bearer",
  auth_header: "authorization",
  auth_query: "key",
  max_retries: 3,
  request_timeout: 120000,
  max_body_size: 2 * 1024 * 1024,
  default_cooldown: 60,
  max_cooldown: 300,
  retryable_statuses: [429, 502, 503],
  cb_threshold: 0,
  cb_window: 60000,
  cb_cooldown: 120000,
  allowed_paths: [],
  // Smart scoring (all optional — 0 means "unknown/unlimited")
  rpm_limit: 0,
  tpm_limit: 0,
  rpd_limit: 0,
  key_cb_threshold: 3,
  key_cb_cooldown: 120000,
  // Max output tokens cap (0 = no cap; enforced in sanitizer)
  max_output_tokens: 0,
};

// Hop-by-hop headers that should not be forwarded
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-connection",
]);

// ── Load providers.json ──────────────────────────────────────────────────────
function loadProvidersConfig() {
  try {
    const raw = fs.readFileSync(PROVIDERS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[keymux] FATAL: Cannot load ${PROVIDERS_FILE}: ${err.message}`);
    process.exit(1);
  }
}

// ── Key ID helper (collision-safe within a provider) ─────────────────────────
function buildKeyIds(keys) {
  const ids = new Map();
  for (let len = 4; len <= 12; len++) {
    ids.clear();
    const suffixes = keys.map((k) => k.slice(-len));
    const unique = new Set(suffixes).size === keys.length;
    if (unique || len === 12) {
      keys.forEach((k, i) => ids.set(k, "…" + suffixes[i]));
      break;
    }
  }
  if (ids.size !== keys.length) {
    ids.clear();
    keys.forEach((k, i) => ids.set(k, `…${k.slice(-4)}#${i}`));
  }
  return ids;
}

// ── SlidingWindow (memory-efficient bucketed counters) ───────────────────────
class SlidingWindow {
  constructor(windowMs = 60000, bucketCount = 60) {
    this.windowMs = windowMs;
    this.bucketCount = bucketCount;
    this.bucketMs = windowMs / bucketCount;
    this.buckets = Array.from({ length: bucketCount }, () => ({ ts: 0, requests: 0, tokens: 0 }));
    this.currentIndex = 0;
  }

  _bucketIndex(now) {
    return Math.floor((now / this.bucketMs) % this.bucketCount);
  }

  _rotate(now) {
    const idx = this._bucketIndex(now);
    const cutoff = now - this.windowMs;
    // Clear any expired buckets
    for (let i = 0; i < this.bucketCount; i++) {
      if (this.buckets[i].ts < cutoff) {
        this.buckets[i] = { ts: 0, requests: 0, tokens: 0 };
      }
    }
    // Initialize current bucket if empty
    if (!this.buckets[idx].ts || this.buckets[idx].ts < cutoff) {
      this.buckets[idx] = { ts: now, requests: 0, tokens: 0 };
    }
    this.currentIndex = idx;
  }

  record(requests = 1, tokens = 0) {
    const now = Date.now();
    this._rotate(now);
    this.buckets[this.currentIndex].requests += requests;
    this.buckets[this.currentIndex].tokens += tokens;
  }

  totals() {
    const now = Date.now();
    this._rotate(now);
    const cutoff = now - this.windowMs;
    let requests = 0, tokens = 0;
    for (const b of this.buckets) {
      if (b.ts >= cutoff) {
        requests += b.requests;
        tokens += b.tokens;
      }
    }
    return { requests, tokens };
  }
}

// ── Token estimation helpers ────────────────────────────────────────────────
function estimateInputTokens(body) {
  if (!body || body.length === 0) return 0;
  try {
    const p = JSON.parse(body);
    if (!Array.isArray(p.messages)) return 0;
    let chars = 0;
    for (const msg of p.messages) {
      if (typeof msg.content === "string") chars += msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") chars += part.length;
          else if (part?.text) chars += part.text.length;
          else if (part?.image_url) chars += 1000; // ~256 tokens for a small image
        }
      }
    }
    // Rough: ~4 chars per token for English
    return Math.max(1, Math.ceil(chars / 4));
  } catch { return 0; }
}

// ── KeyScorer (smart key selection with token-aware scoring) ─────────────────
class KeyScorer {
  constructor(provider) {
    this.provider = provider;
    this.name = provider.name;
    this.keys = provider.keys;

    // Per-key state
    this.windows = new Map();       // key → SlidingWindow (1-minute)
    this.dailyUsage = new Map();    // key → { date, requests, tokens }
    this.consecutiveErrors = new Map(); // key → count
    this.keyCbUntil = new Map();    // key → timestamp (per-key circuit breaker)
    this.lastUsed = new Map();      // key → timestamp (for LRU tie-breaking)
    this.learnedRpm = new Map();    // key → learned RPM limit

    // Config
    this.rpmLimit = provider.rpmLimit || 0;
    this.tpmLimit = provider.tpmLimit || 0;
    this.rpdLimit = provider.rpdLimit || 0;
    this.keyCbThreshold = provider.keyCbThreshold || 3;
    this.keyCbCooldown = provider.keyCbCooldown || 120000;

    // Initialize per-key state
    for (const key of this.keys) {
      this.windows.set(key, new SlidingWindow(60000, 60));
      this.dailyUsage.set(key, { date: todayKey(), requests: 0, tokens: 0 });
      this.consecutiveErrors.set(key, 0);
      this.lastUsed.set(key, 0);
    }
  }

  // ── Core: select best available key ──────────────────────────────────────
  selectKey() {
    const now = Date.now();
    const cooldowns = this.provider.cooldowns;
    let bestKey = null;
    let bestScore = -Infinity;
    let allCircuitOpen = true;

    for (const key of this.keys) {
      // Per-key circuit breaker
      const cbUntil = this.keyCbUntil.get(key) || 0;
      if (now < cbUntil) continue;
      allCircuitOpen = false;

      // Cooldown from 429
      if ((cooldowns.get(key) || 0) > now) continue;

      const score = this._scoreKey(key, now);
      if (score > bestScore) {
        bestScore = score;
        bestKey = key;
      }
    }

    if (allCircuitOpen && this.keys.length > 0) return null;
    if (!bestKey) return null;

    // Immediately mark as used to prevent TOCTOU (concurrent requests picking same key)
    this.lastUsed.set(bestKey, Date.now());

    // Log selection (only when multiple keys exist — avoid spam for single-key)
    if (this.keys.length > 1 && bestScore < 0.5) {
      const w = this.windows.get(bestKey).totals();
      const kid = this.provider.keyId(bestKey);
      console.log(`[keymux:${this.name}:scorer] selected ${kid} score=${bestScore.toFixed(2)} rpm=${w.requests} tpm=${w.tokens}`);
    }

    return bestKey;
  }

  _scoreKey(key, now) {
    const w = this.windows.get(key).totals();
    const daily = this._getDailyUsage(key);

    // Calculate usage ratios (0.0 = idle, 1.0 = at limit)
    const effectiveRpm = this.learnedRpm.get(key) || this.rpmLimit;
    const rpmRatio = effectiveRpm > 0 ? w.requests / effectiveRpm : 0;
    const tpmRatio = this.tpmLimit > 0 ? w.tokens / this.tpmLimit : 0;
    const rpdRatio = this.rpdLimit > 0 ? daily.requests / this.rpdLimit : 0;

    // Score = how much capacity remains (1.0 = fully idle, 0.0 = at limit)
    const usageRatio = Math.max(rpmRatio, tpmRatio, rpdRatio);
    let score = 1.0 - usageRatio;

    // Penalize heavily if approaching any limit (>90% used)
    if (usageRatio > 0.9) score -= 2.0;

    // LRU tie-breaking: slightly prefer keys not used recently
    // Normalize to 0-0.1 range based on time since last use (max 60s)
    const idleMs = now - (this.lastUsed.get(key) || 0);
    const idleBonus = Math.min(idleMs / 60000, 1.0) * 0.1;
    score += idleBonus;

    // Penalize keys with recent consecutive errors (but not CB-open)
    const consErrors = this.consecutiveErrors.get(key) || 0;
    if (consErrors > 0) score -= consErrors * 0.3;

    return score;
  }

  // ── Recording methods ────────────────────────────────────────────────────
  recordRequest(key, inputTokens = 0) {
    this.windows.get(key)?.record(1, inputTokens);
    this.lastUsed.set(key, Date.now());
    const daily = this._getDailyUsage(key);
    daily.requests++;
    daily.tokens += inputTokens;
  }

  recordResponse(key, outputTokens = 0) {
    // Add output tokens to the window (0 requests — just token accounting)
    this.windows.get(key)?.record(0, outputTokens);
    const daily = this._getDailyUsage(key);
    daily.tokens += outputTokens;
  }

  recordSuccess(key) {
    this.consecutiveErrors.set(key, 0);
  }

  recordError(key, statusCode = null) {
    const count = (this.consecutiveErrors.get(key) || 0) + 1;
    this.consecutiveErrors.set(key, count);

    // Learn from 429s
    if (statusCode === 429) {
      this._learnFromRateLimit(key);
    }

    // Per-key circuit breaker
    if (count >= this.keyCbThreshold) {
      const until = Date.now() + this.keyCbCooldown;
      this.keyCbUntil.set(key, until);
      const kid = this.provider.keyId(key);
      console.log(`[keymux:${this.name}:scorer] ${kid} circuit open (${count} consecutive errors), isolating for ${this.keyCbCooldown / 1000}s`);
    }
  }

  // ── Adaptive limit learning ──────────────────────────────────────────────
  _learnFromRateLimit(key) {
    if (!this.rpmLimit) return; // Only learn if baseline is configured
    const w = this.windows.get(key).totals();
    const currentLearned = this.learnedRpm.get(key) || this.rpmLimit;

    // Only ratchet down if we were actually sending at a meaningful rate.
    // A 429 at 1-2 RPM is likely a quota/concurrency limit, not an RPM limit.
    // Floor at 50% of configured limit to avoid collapsing to unusable values.
    const minLearnedRpm = Math.max(2, Math.ceil(this.rpmLimit * 0.5));
    if (w.requests > 2 && w.requests < currentLearned) {
      const newLimit = Math.max(minLearnedRpm, Math.floor(currentLearned * 0.9));
      if (newLimit < currentLearned) {
        this.learnedRpm.set(key, newLimit);
        const kid = this.provider.keyId(key);
        console.log(`[keymux:${this.name}:scorer] ${kid} learned RPM limit: ${currentLearned} → ${newLimit} (hit 429 at ${w.requests} rpm)`);
      }
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────────
  _getDailyUsage(key) {
    const today = todayKey();
    let daily = this.dailyUsage.get(key);
    if (!daily || daily.date !== today) {
      daily = { date: today, requests: 0, tokens: 0 };
      this.dailyUsage.set(key, daily);
    }
    return daily;
  }

  isAllKeysCircuitOpen() {
    const now = Date.now();
    return this.keys.every(k => (this.keyCbUntil.get(k) || 0) > now);
  }

  keyStatuses() {
    const now = Date.now();
    const result = {};
    for (const key of this.keys) {
      const kid = this.provider.keyId(key);
      const w = this.windows.get(key).totals();
      const daily = this._getDailyUsage(key);
      const cbUntil = this.keyCbUntil.get(key) || 0;
      const cooldownUntil = this.provider.cooldowns.get(key) || 0;
      result[kid] = {
        score: parseFloat(this._scoreKey(key, now).toFixed(3)),
        rpm: w.requests,
        tpm: w.tokens,
        rpd: daily.requests,
        learnedRpm: this.learnedRpm.get(key) || null,
        consecutiveErrors: this.consecutiveErrors.get(key) || 0,
        perKeyCB: cbUntil > now ? `open (${Math.ceil((cbUntil - now) / 1000)}s)` : "closed",
        cooldown: cooldownUntil > now ? `${Math.ceil((cooldownUntil - now) / 1000)}s` : null,
        lastUsedAgo: this.lastUsed.get(key) ? `${Math.ceil((now - this.lastUsed.get(key)) / 1000)}s` : "never",
      };
    }
    return result;
  }
}

// ── Provider class (encapsulates all per-provider state) ─────────────────────
class Provider {
  constructor(name, config) {
    this.name = name;
    this.mode = (config.mode || DEFAULTS.mode).toLowerCase();
    this.upstreamUrl = (config.upstream_url || "").replace(/\/+$/, "");
    this.authScheme = (config.auth_scheme || DEFAULTS.auth_scheme).toLowerCase();
    this.authHeader = (config.auth_header || DEFAULTS.auth_header).toLowerCase();
    this.authQuery = config.auth_query || DEFAULTS.auth_query;
    this.maxRetries = config.max_retries ?? DEFAULTS.max_retries;
    this.requestTimeout = config.request_timeout ?? DEFAULTS.request_timeout;
    this.maxBodySize = config.max_body_size ?? DEFAULTS.max_body_size;
    this.defaultCooldown = config.default_cooldown ?? DEFAULTS.default_cooldown;
    this.maxCooldown = config.max_cooldown ?? DEFAULTS.max_cooldown;
    this.retryableStatuses = config.retryable_statuses || DEFAULTS.retryable_statuses;
    this.cbThreshold = config.cb_threshold ?? DEFAULTS.cb_threshold;
    this.cbWindow = config.cb_window ?? DEFAULTS.cb_window;
    this.cbCooldown = config.cb_cooldown ?? DEFAULTS.cb_cooldown;
    this.allowedPaths = config.allowed_paths || DEFAULTS.allowed_paths;

    // Smart scoring config
    this.rpmLimit = config.rpm_limit ?? DEFAULTS.rpm_limit;
    this.tpmLimit = config.tpm_limit ?? DEFAULTS.tpm_limit;
    this.rpdLimit = config.rpd_limit ?? DEFAULTS.rpd_limit;
    this.keyCbThreshold = config.key_cb_threshold ?? DEFAULTS.key_cb_threshold;
    this.keyCbCooldown = config.key_cb_cooldown ?? DEFAULTS.key_cb_cooldown;
    this.maxOutputTokens = config.max_output_tokens ?? DEFAULTS.max_output_tokens;

    // Load keys from env var
    const keysVar = config.keys_var || "API_KEYS";
    this.keys = (process.env[keysVar] || "").split(",").map((k) => k.trim()).filter(Boolean);

    // Validate
    if (!this.keys.length) {
      console.error(`[keymux] FATAL: Provider "${name}" — no keys found in $${keysVar}`);
      process.exit(1);
    }
    if (!["proxy", "rotation"].includes(this.mode)) {
      console.error(`[keymux] FATAL: Provider "${name}" — mode must be "proxy" or "rotation", got "${this.mode}"`);
      process.exit(1);
    }
    if (this.mode === "proxy" && !this.upstreamUrl) {
      console.error(`[keymux] FATAL: Provider "${name}" — upstream_url is required in proxy mode`);
      process.exit(1);
    }
    if (!["bearer", "query", "header", "none"].includes(this.authScheme)) {
      console.error(`[keymux] FATAL: Provider "${name}" — auth_scheme must be "bearer", "query", "header", or "none"`);
      process.exit(1);
    }

    // Cap max_retries at key count
    this.maxRetries = Math.min(this.keys.length, this.maxRetries);

    // Parse upstream host for SSRF
    this.expectedHost = null;
    if (this.upstreamUrl) {
      try {
        this.expectedHost = new URL(this.upstreamUrl).hostname;
      } catch {
        console.error(`[keymux] FATAL: Provider "${name}" — upstream_url is not a valid URL: ${this.upstreamUrl}`);
        process.exit(1);
      }
    }

    // Key IDs for logging/stats
    this.keyIds = buildKeyIds(this.keys);

    // Rotation state
    this.index = 0;
    this.cooldowns = new Map();

    // Circuit breaker state
    this.cbErrors = [];
    this.cbOpenUntil = 0;
    this._cbEpisodeActive = false;

    // Smart key scorer (activates when any rate limit is configured)
    this.scorer = (this.rpmLimit || this.tpmLimit || this.rpdLimit)
      ? new KeyScorer(this) : null;
    if (this.scorer) {
      console.log(`[keymux:${name}] Smart scoring enabled: rpm=${this.rpmLimit || "∞"} tpm=${this.tpmLimit || "∞"} rpd=${this.rpdLimit || "∞"}`);
    }

    // Models cache
    this._modelsCache = null;
    this._modelsCacheExpiry = 0;
    this.modelsCacheTtl = config.models_cache_ttl ?? 300000; // 5 min default

    // Thought signature cache for Gemini 3 tool calling
    // Maps tool_call.id → { signature, ts } with TTL-based eviction
    this._thoughtSigCache = new Map();
    this._thoughtSigMaxSize = 500;
    this._thoughtSigTtl = 300000; // 5 min
  }

  keyId(k) { return this.keyIds.get(k) || "…" + k.slice(-4); }

  // ── Thought signature cache (Gemini 3 tool calling) ─────────────────────────
  cacheThoughtSignature(toolCallId, signature) {
    if (!toolCallId || !signature) return;
    // Evict oldest if at capacity
    if (this._thoughtSigCache.size >= this._thoughtSigMaxSize) {
      const oldest = this._thoughtSigCache.keys().next().value;
      this._thoughtSigCache.delete(oldest);
    }
    this._thoughtSigCache.set(toolCallId, { signature, ts: Date.now() });
  }

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

  // Extract and cache thought signatures from a parsed response object
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
          console.log(`[keymux:${this.name}] cached thought_signature for tool_call ${tc.id.slice(0, 12)}…`);
        }
      }
    }
  }

  // Inject cached thought signatures into outbound request messages.
  // For tool_calls without a cached signature, compact them into text
  // (Gemini 3 rejects tool_calls missing signatures in conversation history)
  injectThoughtSignatures(messages) {
    if (!Array.isArray(messages)) return false;
    let modified = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;

      let allHaveSig = true;
      for (const tc of msg.tool_calls) {
        if (!tc.id) { allHaveSig = false; continue; }
        // Try to inject from cache
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

      // If any tool_calls still lack signatures, compact this assistant message
      // and its corresponding tool result messages into plain text
      if (!allHaveSig) {
        const toolNames = msg.tool_calls.map(tc => tc.function?.name || "tool").join(", ");
        const textContent = msg.content || "";
        // Replace assistant message with text summary
        messages[i] = {
          role: "assistant",
          content: textContent || `[Used tools: ${toolNames}]`,
        };
        modified = true;

        // Remove the following tool result messages (they reference tool_calls
        // that no longer exist after compaction). Splice them out entirely rather
        // than rewriting to "user" role (which would be a privilege escalation risk).
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") {
          messages.splice(j, 1);
          modified = true;
        }

        console.log(`[keymux:${this.name}] compacted tool_call round at msg[${i}] (${toolNames}) — no cached signatures`);
      }
    }

    if (modified) {
      console.log(`[keymux:${this.name}] thought_signature processing: modified conversation history`);
    }
    return modified;
  }

  // ── Key rotation ───────────────────────────────────────────────────────────
  getNextKey() {
    // Smart scoring path
    if (this.scorer) return this.scorer.selectKey();

    // Fallback: original round-robin for providers without rate limits configured
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

  cooldownKey(key, retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    const raw = (Number.isFinite(parsed) && parsed >= 0) ? parsed : this.defaultCooldown;
    const secs = Math.max(0, Math.min(raw, this.maxCooldown));
    this.cooldowns.set(key, Date.now() + secs * 1000);
    console.log(`[keymux:${this.name}] ${this.keyId(key)} rate-limited, cooling ${secs}s`);
    this.recordRateLimit(key);
  }

  keyStatus() {
    const now = Date.now();
    const cooling = this.keys.filter((k) => (this.cooldowns.get(k) || 0) > now).length;
    return { total: this.keys.length, available: this.keys.length - cooling, coolingDown: cooling };
  }

  // ── Circuit breaker ────────────────────────────────────────────────────────
  cbRecordError() {
    if (!this.cbThreshold) return;
    if (this.cbOpenUntil > Date.now()) return; // Already tripped, avoid duplicate
    const now = Date.now();
    this.cbErrors.push(now);
    this.cbErrors = this.cbErrors.filter((t) => now - t < this.cbWindow);
    if (this.cbErrors.length >= this.cbThreshold) {
      this.cbOpenUntil = now + this.cbCooldown;
      this.cbErrors = [];
      const day = getProviderDay(this.name);
      day.circuitBreaks = (day.circuitBreaks || 0) + 1;
      statsDirty = true;
      sendAlert("circuit_open", `[${this.name}] Circuit breaker tripped: ${this.cbThreshold} errors in ${this.cbWindow / 1000}s. Blocking for ${this.cbCooldown / 1000}s.`);
      console.error(`[keymux:${this.name}] CIRCUIT OPEN — blocking requests for ${this.cbCooldown / 1000}s`);
    }
  }

  cbRecordSuccess() {
    if (!this.cbThreshold) return;
    this.cbErrors = [];
  }

  cbIsOpen() {
    // With scorer: global CB only fires when ALL keys are individually broken
    if (this.scorer) {
      if (this.scorer.isAllKeysCircuitOpen()) {
        if (!this._cbEpisodeActive) {
          this._cbEpisodeActive = true;
          this.cbOpenUntil = Date.now() + this.cbCooldown;
          const day = getProviderDay(this.name);
          day.circuitBreaks = (day.circuitBreaks || 0) + 1;
          statsDirty = true;
          sendAlert("circuit_open", `[${this.name}] All keys circuit-broken. Blocking for ${this.cbCooldown / 1000}s.`);
          console.error(`[keymux:${this.name}] ALL KEYS CIRCUIT OPEN — blocking for ${this.cbCooldown / 1000}s`);
        }
        return Date.now() < this.cbOpenUntil;
      }
      if (this._cbEpisodeActive) {
        this._cbEpisodeActive = false;
        this.cbOpenUntil = 0;
        console.log(`[keymux:${this.name}] Circuit breaker closed — resuming requests`);
      }
      return false;
    }

    // Original global CB (no scorer)
    if (!this.cbThreshold) return false;
    if (Date.now() < this.cbOpenUntil) return true;
    if (this.cbOpenUntil > 0) {
      this.cbOpenUntil = 0;
      console.log(`[keymux:${this.name}] Circuit breaker closed — resuming requests`);
    }
    return false;
  }

  // ── Stats recording ────────────────────────────────────────────────────────
  recordRequest(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.requests++;
    day.perKey[this.keyId(key)].requests++;
    statsDirty = true;
  }

  recordRateLimit(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.rateLimited++;
    day.perKey[this.keyId(key)].rateLimited++;
    statsDirty = true;
  }

  recordError(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.errors++;
    day.perKey[this.keyId(key)].errors++;
    statsDirty = true;
  }

  recordAllKeysExhausted() {
    const day = getProviderDay(this.name);
    day.allKeysExhausted++;
    statsDirty = true;
  }

  _emptyDayStats() {
    const perKey = {};
    for (const k of this.keys) {
      perKey[this.keyId(k)] = { requests: 0, rateLimited: 0, errors: 0 };
    }
    return { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey };
  }

  _ensureKeyEntries(day) {
    for (const k of this.keys) {
      const kid = this.keyId(k);
      if (!day.perKey[kid]) day.perKey[kid] = { requests: 0, rateLimited: 0, errors: 0 };
    }
  }

  // ── Models discovery (proxy mode) ──────────────────────────────────────────
  async fetchModels() {
    if (this.mode !== "proxy" || !this.upstreamUrl) return null;
    const now = Date.now();
    if (this._modelsCache && now < this._modelsCacheExpiry) return this._modelsCache;

    const key = this.getNextKey();
    if (!key) return this._modelsCache || null;

    try {
      const upstream = await this.forward(key, "GET", "/v1/models", {}, null);
      const chunks = [];
      let totalBytes = 0;
      const MODELS_MAX_BODY = 10 * 1024 * 1024; // 10MB
      for await (const chunk of upstream) {
        totalBytes += chunk.length;
        if (totalBytes > MODELS_MAX_BODY) throw new Error("models response too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());

      // Normalize: tag each model with provider name
      const models = (body.data || []).map((m) => ({
        ...m,
        provider: this.name,
      }));

      this._modelsCache = models;
      this._modelsCacheExpiry = now + this.modelsCacheTtl;
      return models;
    } catch (err) {
      console.error(`[keymux:${this.name}] models fetch error: ${err.message}`);
      return this._modelsCache || null;
    }
  }

  // ── Forwarding (proxy mode) ────────────────────────────────────────────────
  forward(key, method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
      // Reject path traversal and null bytes
      if (urlPath.includes("\0") || /(?:^|\/)\.\.(?:\/|$)/.test(urlPath)) {
        return reject(new Error("blocked: path traversal or null byte"));
      }

      const base = new URL(this.upstreamUrl);
      const url = new URL(base.pathname.replace(/\/+$/, "") + urlPath, base.origin);

      if (url.hostname !== this.expectedHost) {
        return reject(new Error(`SSRF blocked: ${url.hostname} != ${this.expectedHost}`));
      }

      if (this.authScheme === "query") {
        url.searchParams.set(this.authQuery, key);
      }

      const fwdHeaders = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (!HOP_HEADERS.has(lk) && lk !== "authorization" && lk !== this.authHeader && lk !== "accept-encoding") {
          fwdHeaders[k] = v;
        }
      }
      // Request uncompressed responses so we can inspect/modify response bodies
      fwdHeaders["accept-encoding"] = "identity";

      if (this.authScheme === "bearer") {
        fwdHeaders.authorization = `Bearer ${key}`;
      } else if (this.authScheme === "header") {
        fwdHeaders[this.authHeader] = key;
      }

      fwdHeaders.host = url.host;
      if (body && body.length > 0) {
        fwdHeaders["content-length"] = String(body.length);
      }

      const mod = url.protocol === "https:" ? https : http;
      const opts = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: fwdHeaders,
        timeout: this.requestTimeout,
      };

      const req = mod.request(opts, (res) => resolve(res));
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("upstream timeout")); });
      if (body && body.length > 0) req.write(body);
      req.end();
    });
  }
}

// ── Stats (multi-provider) ───────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.startedAt || !parsed.days || typeof parsed.days !== "object") throw new Error("invalid");
    return parsed;
  } catch {
    return { startedAt: Date.now(), days: {} };
  }
}

const stats = loadStats();
let statsDirty = false;

// Stats are now nested: stats.days["2026-04-04"].providers.gemini.{requests, perKey, ...}
function getProviderDay(providerName) {
  const dateKey = todayKey();
  if (!stats.days[dateKey]) stats.days[dateKey] = { providers: {} };
  if (!stats.days[dateKey].providers) stats.days[dateKey].providers = {};
  if (!stats.days[dateKey].providers[providerName]) {
    const prov = providers.get(providerName);
    stats.days[dateKey].providers[providerName] = prov ? prov._emptyDayStats() : { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey: {} };
  }
  return stats.days[dateKey].providers[providerName];
}

function pruneDays() {
  const keys = Object.keys(stats.days).sort();
  while (keys.length > STATS_RETENTION_DAYS) {
    delete stats.days[keys.shift()];
  }
}

function flushStats() {
  if (!statsDirty) return;
  pruneDays();
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
    statsDirty = false;
  } catch (err) {
    console.error(`[keymux] stats flush error: ${err.message}`);
    try { fs.unlinkSync(STATS_FILE + ".tmp"); } catch {}
  }
}

const flushInterval = setInterval(flushStats, STATS_FLUSH_INTERVAL);

// ── Initialize providers ─────────────────────────────────────────────────────
const providersConfig = loadProvidersConfig();
const providers = new Map();

for (const [name, config] of Object.entries(providersConfig)) {
  // Validate provider name (used in URL path)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    console.error(`[keymux] FATAL: Provider name "${name}" must be lowercase alphanumeric (hyphens/underscores ok, no leading special chars)`);
    process.exit(1);
  }
  providers.set(name, new Provider(name, config));
}

if (providers.size === 0) {
  console.error(`[keymux] FATAL: No providers defined in ${PROVIDERS_FILE}`);
  process.exit(1);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
// Per-IP rate limiting on auth failures (brute-force protection)
const AUTH_FAIL_WINDOW = 60000;  // 1 minute
const AUTH_FAIL_MAX = 10;        // max failures per IP per window
const AUTH_BLOCK_DURATION = 300000; // 5 minutes block after exceeding
const authFailures = new Map();  // ip → { count, windowStart, blockedUntil }
const AUTH_FAILURES_MAX = 100000; // size cap to prevent unbounded growth

function isAuthBlocked(ip) {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  const now = Date.now();
  if (entry.blockedUntil && now < entry.blockedUntil) return true;
  if (entry.blockedUntil && now >= entry.blockedUntil) {
    authFailures.delete(ip);
    return false;
  }
  return false;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  let entry = authFailures.get(ip);
  if (!entry || (now - entry.windowStart) > AUTH_FAIL_WINDOW) {
    entry = { count: 0, windowStart: now, blockedUntil: 0 };
  }
  entry.count++;
  if (entry.count >= AUTH_FAIL_MAX) {
    entry.blockedUntil = now + AUTH_BLOCK_DURATION;
    console.warn(`[keymux] AUTH: IP ${ip} blocked for ${AUTH_BLOCK_DURATION / 1000}s (${entry.count} failures)`);
  }
  authFailures.set(ip, entry);
  // Evict oldest entries if map grows too large (distributed brute-force protection)
  if (authFailures.size > AUTH_FAILURES_MAX) {
    const iter = authFailures.keys();
    for (let i = 0; i < 1000; i++) authFailures.delete(iter.next().value);
  }
}

// Periodic cleanup of stale auth failure entries (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of authFailures) {
    if (entry.blockedUntil && now >= entry.blockedUntil) authFailures.delete(ip);
    else if ((now - entry.windowStart) > AUTH_FAIL_WINDOW * 2) authFailures.delete(ip);
  }
}, 300000);

function checkAuth(req, requiredKey) {
  if (!requiredKey) return true;
  const auth = req.headers["authorization"] || "";
  const expected = `Bearer ${requiredKey}`;
  const authBuf = Buffer.from(auth);
  const expectedBuf = Buffer.from(expected);
  if (authBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(authBuf, expectedBuf);
}

// Admin key: ADMIN_KEY only — no fallback to PROXY_KEY (separation of concerns).
// If ADMIN_KEY is unset, admin endpoints (/stats, /health details) are inaccessible.
const EFFECTIVE_ADMIN_KEY = ADMIN_KEY;

function sendUnauthorized(res, req) {
  const ip = req?.socket?.remoteAddress || "unknown";
  recordAuthFailure(ip);
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── Webhook alerts ───────────────────────────────────────────────────────────
const _alertThrottles = new Map(); // event → lastSentTimestamp
const ALERT_THROTTLE_MS = 60000; // max 1 webhook per event type per 60s

function sendAlert(event, message) {
  const now = Date.now();
  const lastSent = _alertThrottles.get(event) || 0;
  const webhookThrottled = (now - lastSent) < ALERT_THROTTLE_MS;
  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    message,
  });

  if (ALERT_WEBHOOK_URL && !webhookThrottled) {
    _alertThrottles.set(event, now);
    try {
      const url = new URL(ALERT_WEBHOOK_URL);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
        timeout: ALERT_TIMEOUT,
      });
      req.on("response", (res) => res.resume());
      req.on("error", (err) => console.error(`[keymux] alert webhook error: ${err.message}`));
      req.on("timeout", () => req.destroy());
      req.write(payload);
      req.end();
    } catch (err) {
      console.error(`[keymux] alert webhook error: ${err.message}`);
    }
  }

  console.warn(`[keymux] ALERT: ${event} — ${message}`);
}

// ── Shared helpers ───────────────────────────────────────────────────────────
function filterResponseHeaders(rawHeaders) {
  const filtered = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  }
  return filtered;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Route: /health ───────────────────────────────────────────────────────────
function handleHealth(req, res) {
  const now = Date.now();
  const isAdmin = EFFECTIVE_ADMIN_KEY && checkAuth(req, EFFECTIVE_ADMIN_KEY);
  let anyDegraded = false;

  const providerStatuses = {};
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    const circuitOpen = prov.cbIsOpen();
    if (ks.available === 0 || circuitOpen) anyDegraded = true;

    const entry = {
      mode: prov.mode,
      available: ks.available,
      coolingDown: ks.coolingDown,
      circuitBreaker: prov.cbThreshold ? (circuitOpen ? "open" : "closed") : "disabled",
    };

    if (isAdmin) {
      entry.keys = ks.total;
      const day = getProviderDay(name);
      prov._ensureKeyEntries(day);
      entry.today = {
        requests: day.requests,
        rateLimited: day.rateLimited,
        allKeysExhausted: day.allKeysExhausted,
        errors: day.errors,
        circuitBreaks: day.circuitBreaks || 0,
        perKey: day.perKey,
      };
      if (prov.scorer) {
        entry.scoring = {
          limits: { rpm: prov.rpmLimit || "∞", tpm: prov.tpmLimit || "∞", rpd: prov.rpdLimit || "∞" },
          keys: prov.scorer.keyStatuses(),
        };
      }
    }

    providerStatuses[name] = entry;
  }

  const statusCode = anyDegraded ? 503 : 200;
  res.writeHead(statusCode, { "content-type": "application/json" });
  // Only show provider details to authenticated callers
  const payload = isAdmin
    ? { status: anyDegraded ? "degraded" : "ok", uptime: formatUptime(now - stats.startedAt), providers: providerStatuses }
    : { status: anyDegraded ? "degraded" : "ok" };
  res.end(JSON.stringify(payload));
}

// ── Route: /stats ────────────────────────────────────────────────────────────
function handleStats(req, res) {
  if (!EFFECTIVE_ADMIN_KEY || !checkAuth(req, EFFECTIVE_ADMIN_KEY)) return sendUnauthorized(res, req);
  const now = Date.now();

  const providerStatuses = {};
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    providerStatuses[name] = {
      mode: prov.mode,
      keys: ks.total,
      available: ks.available,
      coolingDown: ks.coolingDown,
      circuitBreaker: prov.cbThreshold ? (prov.cbIsOpen() ? "open" : "closed") : "disabled",
    };
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    uptime: formatUptime(now - stats.startedAt),
    startedAt: new Date(stats.startedAt).toISOString(),
    providers: providerStatuses,
    days: stats.days,
  }));
}

// ── Route: /:provider/key (rotation mode) ────────────────────────────────────
function handleKeyRequest(req, res, prov) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res, req);

  if (prov.cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open", provider: prov.name }));
  }

  const key = prov.getNextKey();
  if (!key) {
    prov.recordAllKeysExhausted();
    sendAlert("all_keys_exhausted", `[${prov.name}] All ${prov.keys.length} keys are rate limited.`);
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "All keys rate limited", provider: prov.name }));
  }

  prov.recordRequest(key);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ key, upstream_url: prov.upstreamUrl || null, provider: prov.name }));
}

// ── Route: /:provider/key/:id/cooldown (rotation mode) ──────────────────────
function handleCooldownReport(req, res, prov, keyFragment) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res, req);

  if (keyFragment.length < 4) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key fragment must be at least 4 characters" }));
  }

  const match = prov.keys.find((k) => k.endsWith(keyFragment));
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key not found", provider: prov.name }));
  }

  const chunks = [];
  let totalSize = 0;
  req.on("data", (c) => {
    totalSize += c.length;
    if (totalSize <= 1024) chunks.push(c);
  });
  req.on("error", (err) => {
    console.error(`[keymux:${prov.name}] cooldown request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request error" }));
    }
  });
  req.on("end", () => {
    if (totalSize > 1024) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "body too large" }));
    }
    let retryAfter = String(prov.defaultCooldown);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.retry_after) retryAfter = String(body.retry_after);
    } catch {}
    prov.cooldownKey(match, retryAfter);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "cooled", key: prov.keyId(match), provider: prov.name }));
  });
}

// ── Route: /:provider/* (proxy mode) ─────────────────────────────────────────
async function handleProxy(req, res, prov, proxyPath) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res, req);

  if (prov.cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open", provider: prov.name }));
  }

  // Check allowed paths
  if (prov.allowedPaths.length > 0) {
    let normalized;
    try { normalized = decodeURIComponent(proxyPath.split("?")[0]); } catch { normalized = proxyPath.split("?")[0]; }
    if (!prov.allowedPaths.some((p) => normalized === p || normalized.startsWith(p.endsWith("/") ? p : p + "/"))) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden: path not allowed" }));
    }
  }

  // Pre-check Content-Length
  const declaredLength = parseInt(req.headers["content-length"], 10);
  if (Number.isFinite(declaredLength) && declaredLength > prov.maxBodySize) {
    res.writeHead(413, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "request body too large", max: prov.maxBodySize }));
  }

  // Collect body
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > prov.maxBodySize) {
      req.resume(); // Drain remaining data without destroying
      if (!res.headersSent) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large", max: prov.maxBodySize }));
      }
      return;
    }
    chunks.push(chunk);
  }
  let body = Buffer.concat(chunks);
  const headers = { ...req.headers };

  // Sanitize: strip non-standard OpenAI params and enforce token caps
  // (e.g. Gemini rejects "store", "reasoning_effort", "thinking"; Groq caps max_completion_tokens)
  if (req.url.includes("chat/completions") && body.length > 0) {
    try {
      const p = JSON.parse(body);
      let modified = false;

      // Normalize max_completion_tokens → max_tokens BEFORE stripping
      // Gemini's OpenAI-compat API only understands max_tokens, not max_completion_tokens
      if (typeof p.max_completion_tokens === "number" && p.max_completion_tokens > 0) {
        if (typeof p.max_tokens !== "number" || p.max_tokens <= 0) {
          p.max_tokens = p.max_completion_tokens;
        }
        delete p.max_completion_tokens;
        modified = true;
        console.log(`[sanitize] normalized max_completion_tokens → max_tokens: ${p.max_tokens}`);
      }

      // Strip non-standard keys
      const allowed = new Set([
        "model", "messages", "stream", "stream_options",
        "max_tokens", "temperature",
        "tools", "tool_choice", "top_p", "n", "stop",
        "parallel_tool_calls", "response_format", "seed",
        "frequency_penalty", "presence_penalty",
        "logprobs", "top_logprobs", "user",
      ]);
      const removed = Object.keys(p).filter(k => !allowed.has(k));
      if (removed.length > 0) {
        for (const k of removed) delete p[k];
        modified = true;
        console.log("[sanitize] stripped non-standard keys:", removed.join(", "));
      }

      // Cap max output tokens if provider has a limit
      if (prov.maxOutputTokens > 0) {
        if (typeof p.max_tokens === "number" && p.max_tokens > prov.maxOutputTokens) {
          console.log(`[sanitize] capped max_tokens: ${p.max_tokens} → ${prov.maxOutputTokens}`);
          p.max_tokens = prov.maxOutputTokens;
          modified = true;
        }
      }

      // Inject cached thought signatures for Gemini 3 tool calling
      if (prov.injectThoughtSignatures(p.messages)) {
        modified = true;
      }

      if (modified) {
        body = Buffer.from(JSON.stringify(p));
        headers["content-length"] = String(body.length);
      }
    } catch (e) { /* not JSON, pass through */ }
  }

  // Retry loop
  const attempts = prov.maxRetries + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = prov.getNextKey();
    if (!key) {
      prov.recordAllKeysExhausted();
      sendAlert("all_keys_exhausted", `[${prov.name}] All ${prov.keys.length} keys are rate limited.`);
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "All keys rate limited", provider: prov.name }));
    }

    prov.recordRequest(key);

    // Estimate input tokens for scorer
    const inputTokens = prov.scorer ? estimateInputTokens(body) : 0;
    if (prov.scorer) prov.scorer.recordRequest(key, inputTokens);

    try {
      const upstream = await prov.forward(key, req.method, proxyPath, headers, body);

      if (prov.retryableStatuses.includes(upstream.statusCode)) {
        upstream.resume();
        if (upstream.statusCode === 429) {
          prov.cooldownKey(key, upstream.headers["retry-after"]);
        }
        prov.cbRecordError();
        if (prov.scorer) prov.scorer.recordError(key, upstream.statusCode);
        if (attempt < attempts - 1) {
          // Exponential backoff: 100ms, 200ms, 400ms, ... capped at 2s
          const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        res.writeHead(upstream.statusCode, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `upstream returned ${upstream.statusCode}`, provider: prov.name }));
      }

      // Non-retryable response — record success only for 2xx/3xx
      if (upstream.statusCode < 400) {
        prov.cbRecordSuccess();
        if (prov.scorer) prov.scorer.recordSuccess(key);
      } else {
        prov.cbRecordError();
        if (prov.scorer) prov.scorer.recordError(key, upstream.statusCode);
        // Debug: log 400 errors with upstream response body and request summary
        if (upstream.statusCode === 400) {
          const errChunks = [];
          let errBytes = 0;
          upstream.on("data", (c) => {
            errBytes += c.length;
            if (errBytes <= 8192) errChunks.push(c); // Cap error body read
          });
          upstream.on("end", () => {
            upstream.destroy(); // Ensure socket is released
            // Scrub: only log structured error fields, not raw response bodies
            let errMsg = "unknown";
            try {
              const raw = Buffer.concat(errChunks).toString();
              let parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) parsed = parsed[0] || {};
              errMsg = parsed?.error?.message || parsed?.error?.status || "unparseable";
            } catch { errMsg = "non-JSON response"; }
            let reqSummary = "";
            try {
              const p = JSON.parse(body);
              reqSummary = `model=${p.model} msgs=${(p.messages||[]).length} tools=${(p.tools||[]).length}`;
            } catch {}
            console.error(`[keymux:${prov.name}] 400 from upstream: ${errMsg} | ${reqSummary}`);
          });
          upstream.on("error", () => {}); // Swallow errors during drain
          res.writeHead(400, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "upstream returned 400" }));
        }
      }
      const safeHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.statusCode, safeHeaders);
      // Use longer timeout for streaming responses (SSE can take minutes)
      const isStreaming = (upstream.headers["content-type"] || "").includes("text/event-stream");
      const streamTimeout = isStreaming ? Math.max(prov.requestTimeout * 3, 360000) : prov.requestTimeout;
      let pipeTimedOut = false;
      const pipeTimeout = setTimeout(() => {
        pipeTimedOut = true;
        console.error(`[keymux:${prov.name}] response pipe timeout (${streamTimeout / 1000}s) — destroying upstream`);
        upstream.destroy();
        if (!res.writableEnded) res.end();
      }, streamTimeout);
      upstream.on("error", (err) => {
        pipeTimedOut = true;
        clearTimeout(pipeTimeout);
        console.error(`[keymux:${prov.name}] upstream pipe error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
      res.on("close", () => { pipeTimedOut = true; clearTimeout(pipeTimeout); upstream.destroy(); });

      // Intercept response: extract usage data + thought signatures for Gemini 3
      const needsIntercept = prov.scorer || proxyPath.includes("chat/completions");
      if (needsIntercept) {
        let usageExtracted = false;
        const parseSSELines = (str) => {
          const results = [];
          const lines = str.includes("data: ") ? str.split("\n").filter(l => l.startsWith("data: ")) : [str];
          for (const line of lines) {
            const json = line.startsWith("data: ") ? line.slice(6) : line;
            if (json === "[DONE]" || !json.trim()) continue;
            try { results.push(JSON.parse(json)); } catch {}
          }
          return results;
        };

        let pendingSSE = ""; // Buffer for cross-chunk SSE parsing
        upstream.on("data", (chunk) => {
          if (!pipeTimedOut && !res.writableEnded && !res.destroyed) res.write(chunk);
          const str = chunk.toString();

          // Buffer SSE data for cross-chunk parsing of thought signatures
          pendingSSE += str;
          // Process complete SSE lines (delimited by \n\n)
          const parts = pendingSSE.split("\n\n");
          pendingSSE = parts.pop() || ""; // Keep incomplete last part
          for (const part of parts) {
            if (!part.trim()) continue;
            // Extract thought signatures from tool_call responses
            if (part.includes('"tool_calls"') || part.includes('"thought_signature"')) {
              for (const parsed of parseSSELines(part)) {
                prov.extractThoughtSignatures(parsed);
              }
            }
            // Extract usage for scorer
            if (prov.scorer && !usageExtracted && part.includes('"usage"')) {
              for (const parsed of parseSSELines(part)) {
                if (parsed?.usage) {
                  const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                  if (outTokens > 0) {
                    prov.scorer.recordResponse(key, outTokens);
                    usageExtracted = true;
                  }
                }
              }
            }
          }
        });
        upstream.on("end", () => {
          clearTimeout(pipeTimeout);
          // Process any remaining buffered SSE data
          if (pendingSSE.trim()) {
            for (const parsed of parseSSELines(pendingSSE)) {
              prov.extractThoughtSignatures(parsed);
              // Extract usage from final chunk (non-streaming responses)
              if (prov.scorer && !usageExtracted && parsed?.usage) {
                const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                if (outTokens > 0) {
                  prov.scorer.recordResponse(key, outTokens);
                  usageExtracted = true;
                }
              }
            }
          }
          if (!res.writableEnded) res.end();
        });
      } else {
        upstream.on("end", () => clearTimeout(pipeTimeout));
        upstream.pipe(res);
      }
      return;
    } catch (err) {
      console.error(`[keymux:${prov.name}] ${prov.keyId(key)} error: ${err.message}`);
      prov.recordError(key);
      prov.cbRecordError();
      if (prov.scorer) prov.scorer.recordError(key);
      if (attempt < attempts - 1) {
        const backoffMs = Math.min(100 * Math.pow(2, attempt), 2000);
        await new Promise(r => setTimeout(r, backoffMs));
      }
      if (attempt === attempts - 1) {
        res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "upstream error", provider: prov.name }));
      }
    }
  }
}

// ── Request router ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  // Per-IP brute-force protection
  const clientIp = req.socket?.remoteAddress || "unknown";
  if (isAuthBlocked(clientIp)) {
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "too many auth failures, try again later" }));
  }

  // Strip query string for route matching
  const reqPath = req.url.split("?")[0];

  // Global endpoints
  if (req.method === "GET" && reqPath === "/health") return handleHealth(req, res);
  if (req.method === "GET" && reqPath === "/stats") return handleStats(req, res);

  // Aggregated models from all proxy-mode providers
  if (req.method === "GET" && reqPath === "/models") {
    if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res, req);
    const allModels = [];
    const promises = [];
    for (const [name, prov] of providers) {
      if (prov.mode === "proxy") {
        const p = Promise.race([
          prov.fetchModels(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 10000)),
        ]).then((m) => m && allModels.push(...m))
         .catch((err) => console.error(`[keymux:${name}] /models fetch failed: ${err.message}`));
        promises.push(p);
      }
    }
    await Promise.allSettled(promises);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: allModels }));
  }

  // List providers (requires PROXY_KEY)
  if (req.method === "GET" && reqPath === "/providers") {
    if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res, req);
    const list = {};
    for (const [name, prov] of providers) {
      list[name] = { mode: prov.mode };
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ providers: list }));
  }

  // Parse /:provider/... from URL
  const match = req.url.match(/^\/([a-z0-9][a-z0-9_-]*)(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  const providerName = match[1];
  const subPath = match[2] || "/";
  const prov = providers.get(providerName);

  if (!prov) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unknown provider" }));
  }

  // Rotation mode endpoints
  if (prov.mode === "rotation") {
    if (req.method === "GET" && subPath === "/key") return handleKeyRequest(req, res, prov);

    const cooldownMatch = subPath.match(/^\/key\/([^/]+)\/cooldown$/);
    if (req.method === "POST" && cooldownMatch) {
      return handleCooldownReport(req, res, prov, cooldownMatch[1]);
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  // Proxy mode — forward subPath to upstream
  return handleProxy(req, res, prov, subPath);
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[keymux] unhandled: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
});

// Global error handlers
process.on("unhandledRejection", (err) => {
  console.error(`[keymux] unhandled rejection: ${err?.message || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[keymux] uncaught exception: ${err.message}`);
  flushStats();
  process.exit(1);
});

// Graceful shutdown
let forceExitTimer;
function shutdown(signal) {
  console.log(`[keymux] ${signal} received, shutting down...`);
  flushStats();
  clearInterval(flushInterval);
  server.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
  forceExitTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Pre-flight safety checks (before server accepts connections)
const hasRotation = [...providers.values()].some((p) => p.mode === "rotation");
if (!PROXY_KEY && hasRotation) {
  console.error(`[keymux] FATAL: PROXY_KEY is required when any provider uses rotation mode (raw keys are exposed)`);
  process.exit(1);
}

server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`[keymux] KeyMux on ${BIND_ADDRESS}:${PORT} with ${providers.size} provider(s)`);
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    console.log(`[keymux]   /${name} [${prov.mode}] ${ks.total} key(s)${prov.mode === "proxy" ? ` → ${prov.expectedHost}` : ""} (auth: ${prov.authScheme})`);
  }
  if (!PROXY_KEY && !ADMIN_KEY) console.warn(`[keymux] WARNING: No PROXY_KEY or ADMIN_KEY set — endpoints are open to anyone with network access`);
  if (PROXY_KEY) console.log(`[keymux] Inbound auth: PROXY_KEY required`);
  if (EFFECTIVE_ADMIN_KEY) console.log(`[keymux] Admin auth: ADMIN_KEY required for /stats`);
  else console.warn(`[keymux] WARNING: ADMIN_KEY not set — /stats and /health details are disabled`);
  console.log(`[keymux] Stats: ${fs.existsSync(STATS_FILE) ? "loaded from disk" : "fresh start"}`);
});
