/**
 * ModelDiscovery — dynamically fetches models from upstream providers.
 *
 * Periodically queries each provider's /models endpoint, filters out
 * non-chat models, and caches the results. For Gemini providers,
 * also fetches native API specs (inputTokenLimit / outputTokenLimit).
 *
 * Zero dependencies — uses Node built-in http/https.
 */
const http = require("http");
const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────
const HTTP_MAX_BODY = 10 * 1024 * 1024; // 10MB safety cap
const NATIVE_BATCH_SIZE = 5;

// Defaults for configurable discovery settings
const DEFAULT_DISCOVERY_TIMEOUT = 30000;       // 30s hard deadline
const DEFAULT_DISCOVERY_SOCKET_TIMEOUT = 15000; // 15s socket idle
const DEFAULT_SPEC_TIMEOUT = 30000;            // 30s aggregate for native spec fetches
const DEFAULT_MIN_CONTEXT_WINDOW = 32768;      // 32K — agents with tools need room
const DEFAULT_MIN_OUTPUT_TOKENS = 4096;        // agents need room to respond
const DEFAULT_MIN_PARAM_BILLIONS = 4;
const DEFAULT_MIN_TPM = 20000;                 // 20K TPM — below this, single agent turn can't fit

const NON_CHAT_RE = /embed|imagen|veo|lyria|aqa|tts|audio|live|robotics|generate|clip|guard|whisper|distil|orpheus|safeguard/i;
const IMAGE_RE = /\bimage\b/i;
const SPECIAL_RE = /deep-research|computer-use|customtools/i;

// ── HTTP helper (zero deps) ───────────────────────────────────────────────
function httpGet(url, headers, { wallTimeout = DEFAULT_DISCOVERY_TIMEOUT, socketTimeout = DEFAULT_DISCOVERY_SOCKET_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const mod = url.startsWith("https://") ? https : http;
    const wallTimer = setTimeout(() => {
      req.destroy();
      done(reject, new Error("wall-clock timeout"));
    }, wallTimeout);
    const req = mod.get(url, { headers, timeout: socketTimeout }, (res) => {
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (c) => {
        totalBytes += c.length;
        if (totalBytes > HTTP_MAX_BODY) {
          clearTimeout(wallTimer);
          req.destroy();
          return done(reject, new Error("response too large"));
        }
        chunks.push(c);
      });
      res.on("error", (e) => { clearTimeout(wallTimer); done(reject, e); });
      res.on("end", () => {
        clearTimeout(wallTimer);
        if (res.statusCode !== 200) return done(reject, new Error(`HTTP ${res.statusCode}`));
        try {
          done(resolve, JSON.parse(Buffer.concat(chunks).toString()));
        } catch (parseErr) {
          done(reject, new Error(`Invalid JSON from ${url.split("?")[0]}: ${parseErr.message}`));
        }
      });
    });
    req.on("error", (e) => { clearTimeout(wallTimer); done(reject, e); });
    req.on("timeout", () => { clearTimeout(wallTimer); req.destroy(new Error("socket timeout")); });
  });
}

// ── Native spec fetcher (Gemini) ──────────────────────────────────────────
async function fetchGeminiSpecs(modelIds, apiKey, specTimeout = DEFAULT_SPEC_TIMEOUT) {
  const specs = {};
  const deadline = Date.now() + specTimeout;

  for (let i = 0; i < modelIds.length; i += NATIVE_BATCH_SIZE) {
    if (Date.now() > deadline) break;
    const batch = modelIds.slice(i, i + NATIVE_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (id) => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${id}`;
      const data = await httpGet(url, { "x-goog-api-key": apiKey });
      return {
        id,
        contextWindow: data.inputTokenLimit || 0,
        maxOutputTokens: data.outputTokenLimit || 0,
      };
    }));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.contextWindow > 0) {
        specs[r.value.id] = {
          contextWindow: r.value.contextWindow,
          maxOutputTokens: r.value.maxOutputTokens,
        };
      }
    }
  }
  return specs;
}

class ModelDiscovery {
  /**
   * @param {object} opts
   * @param {import('./pool')} opts.pool   - Pool instance (for provider access)
   * @param {object}  [opts.logger]        - Logger with .log(), .warn(), .error()
   */
  constructor({ pool, logger, minTpm = DEFAULT_MIN_TPM,
    minContextWindow = DEFAULT_MIN_CONTEXT_WINDOW, minOutputTokens = DEFAULT_MIN_OUTPUT_TOKENS,
    minParamBillions = DEFAULT_MIN_PARAM_BILLIONS, discoveryTimeout = DEFAULT_DISCOVERY_TIMEOUT,
    discoverySocketTimeout = DEFAULT_DISCOVERY_SOCKET_TIMEOUT, specTimeout = DEFAULT_SPEC_TIMEOUT } = {}) {
    this._pool = pool;
    this._logger = logger || console;
    this._minTpm = minTpm;
    this._minContextWindow = minContextWindow;
    this._minOutputTokens = minOutputTokens;
    this._minParamBillions = minParamBillions;
    this._discoveryTimeout = discoveryTimeout;
    this._discoverySocketTimeout = discoverySocketTimeout;
    this._specTimeout = specTimeout;
    this._onRefresh = null; // callback: (modelIndex, cache) => void

    /** @type {Map<string, { models: object[], fetchedAt: number }>} */
    this._cache = new Map();

    /** @type {Map<string, { provider: string, contextWindow: number, maxOutputTokens: number, inputTypes: string[] }>} */
    this._modelIndex = new Map();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Fetch models from all providers, filter, and cache.
   */
  async refresh() {
    const providerNames = this._pool.providerNames();
    const newCache = new Map();
    const newIndex = new Map();

    for (const provName of providerNames) {
      try {
        const models = await this._fetchProviderModels(provName);
        if (!models) continue;

        const filtered = this._filterModels(models, provName);
        if (filtered.length === 0) {
          this._logger.log(`[discovery] ${provName}: 0 chat models after filtering`);
          continue;
        }

        // For Gemini: fetch native specs for models missing context_window
        let nativeSpecs = {};
        const prov = this._pool.getProvider(provName);
        const isGemini = provName.toLowerCase().includes("gemini") ||
          (prov && prov.authHeader === "x-goog-api-key");

        if (isGemini) {
          const missingIds = filtered
            .filter(m => !m.context_window)
            .map(m => m._cleanId);
          if (missingIds.length > 0) {
            const apiKey = this._getProviderKey(provName);
            if (apiKey) {
              try {
                nativeSpecs = await fetchGeminiSpecs(missingIds, apiKey, this._specTimeout);
                this._logger.log(`[discovery] ${provName}: got native specs for ${Object.keys(nativeSpecs).length} models`);
              } catch (err) {
                this._logger.warn(`[discovery] ${provName}: native spec fetch failed: ${err.message}`);
              }
            }
          }
        }

        // Build enriched model list
        const beforeCount = filtered.length;
        const enriched = [];
        for (const m of filtered) {
          const cleanId = m._cleanId;
          const native = nativeSpecs[cleanId] || {};
          const contextWindow = native.contextWindow || m.context_window || 0;
          const maxOutputTokens = native.maxOutputTokens || m.max_completion_tokens || 0;

          // Post-enrichment filters: now we know real specs
          if (contextWindow > 0 && this._minContextWindow > 0 && contextWindow < this._minContextWindow) continue;
          if (maxOutputTokens > 0 && this._minOutputTokens > 0 && maxOutputTokens < this._minOutputTokens) continue;

          // Wall 3: Filter models whose provider TPM is too low for agent use.
          // Configurable via FFAI_MIN_TPM (default 20K). Set to 0 to disable.
          const modelTpm = this._getModelTpm(provName, cleanId);
          if (this._minTpm > 0 && modelTpm > 0 && modelTpm < this._minTpm) continue;

          // Skip deprecated models
          if (this._pool.deprecationTracker && this._pool.deprecationTracker.isDeprecated(cleanId)) continue;

          // Image support heuristic
          const supportsImage = /\bgemini\b|\bflash\b|\bvision\b|\bgrok-4-fast\b|\bllama-4\b|\bscout\b|\bgemma-[34]/.test(cleanId);
          const inputTypes = supportsImage ? ["text", "image"] : ["text"];

          enriched.push({
            id: cleanId,
            object: "model",
            owned_by: provName,
            provider: provName,
            context_window: contextWindow,
            max_output_tokens: maxOutputTokens,
            input_types: inputTypes,
          });
        }
        if (enriched.length < beforeCount) {
          this._logger.log(`[discovery] ${provName}: dropped ${beforeCount - enriched.length} models (specs below minimums or deprecated)`);
        }

        newCache.set(provName, { models: enriched, fetchedAt: Date.now() });

        for (const m of enriched) {
          newIndex.set(m.id, {
            provider: m.provider,
            contextWindow: m.context_window,
            maxOutputTokens: m.max_output_tokens,
            inputTypes: m.input_types,
          });
        }

        this._logger.log(`[discovery] ${provName}: ${enriched.length} models discovered`);
      } catch (err) {
        this._logger.warn(`[discovery] ${provName}: fetch failed: ${err.message}`);
        // Keep stale cache entry if one exists
        if (this._cache.has(provName)) {
          newCache.set(provName, this._cache.get(provName));
          for (const m of this._cache.get(provName).models) {
            newIndex.set(m.id, {
              provider: m.provider,
              contextWindow: m.context_window,
              maxOutputTokens: m.max_output_tokens,
              inputTypes: m.input_types,
            });
          }
        }
      }
    }

    this._cache = newCache;
    this._modelIndex = newIndex;
    this._logger.log(`[discovery] refresh complete: ${this._modelIndex.size} total models across ${this._cache.size} providers`);

    // Feature 5: populate capability store if available
    if (this._pool.capabilities) {
      for (const [modelId, info] of this._modelIndex) {
        this._pool.capabilities.ingestFromDiscovery(modelId, info.provider, {
          contextWindow: info.contextWindow,
          maxOutputTokens: info.maxOutputTokens,
          inputTypes: info.inputTypes,
        });
      }
    }

    // Fire onRefresh callback (used by OpenClaw sync)
    if (typeof this._onRefresh === "function") {
      try {
        this._onRefresh(this._modelIndex, this._cache);
      } catch (err) {
        this._logger.warn(`[discovery] onRefresh callback error: ${err.message}`);
      }
    }
  }

  /**
   * Register a callback to be called after each successful refresh.
   * @param {function} fn - (modelIndex: Map, cache: Map) => void
   */
  onRefresh(fn) {
    this._onRefresh = fn;
  }

  /**
   * Get all cached discovered models merged across providers.
   * @returns {object[]}
   */
  getAllModels() {
    const all = [];
    for (const entry of this._cache.values()) {
      all.push(...entry.models);
    }
    return all;
  }

  /**
   * Get info for a specific model by ID.
   * @param {string} modelId
   * @returns {{ provider: string, contextWindow: number, maxOutputTokens: number, inputTypes: string[] } | null}
   */
  getModelInfo(modelId) {
    return this._modelIndex.get(modelId) || null;
  }

  // ── Internal methods ────────────────────────────────────────────────────

  /**
   * Fetch raw model list from a provider's upstream /models endpoint.
   * @param {string} provName
   * @returns {object[]|null}
   */
  async _fetchProviderModels(provName) {
    const prov = this._pool.getProvider(provName);
    if (!prov) return null;

    // Get upstream URL from providerConfigs (stored on pool by serve.js)
    const upstreamUrl = this._pool._upstreamUrls && this._pool._upstreamUrls[provName];
    if (!upstreamUrl) {
      this._logger.warn(`[discovery] ${provName}: no upstream_url, skipping`);
      return null;
    }

    // Get one key without going through acquire/release (don't affect scoring)
    const apiKey = this._getProviderKey(provName);
    if (!apiKey) {
      this._logger.warn(`[discovery] ${provName}: no keys available, skipping`);
      return null;
    }

    // Build auth headers
    const headers = {};
    if (prov.authScheme === "bearer") {
      headers.authorization = `Bearer ${apiKey}`;
    } else if (prov.authScheme === "header") {
      headers[prov.authHeader] = apiKey;
    }

    // Fetch /v1/models — upstream_url is the base (e.g., https://api.groq.com/openai),
    // and serve.js prepends /v1/ for all API calls, so models live at {upstream}/v1/models
    let modelsUrl = `${upstreamUrl}/v1/models`;
    const resp = await httpGet(modelsUrl, headers, { wallTimeout: this._discoveryTimeout, socketTimeout: this._discoverySocketTimeout });

    // OpenAI-compat: { data: [...] } or Gemini native: { models: [...] }
    const models = resp.data || resp.models;
    if (!Array.isArray(models)) {
      this._logger.warn(`[discovery] ${provName}: /models response missing data array`);
      return null;
    }
    return models;
  }

  /**
   * Get the first key from a provider without acquire/release.
   * @param {string} provName
   * @returns {string|null}
   */
  _getProviderKey(provName) {
    const prov = this._pool.getProvider(provName);
    if (!prov || !prov.keys || prov.keys.length === 0) return null;
    return prov.keys[0];
  }

  /**
   * Get the effective TPM limit for a model on a provider.
   * Checks per-model limits first, then falls back to provider default.
   * Returns 0 if unknown (no TPM limit configured).
   * @param {string} provName
   * @param {string} modelId
   * @returns {number}
   */
  _getModelTpm(provName, modelId) {
    const prov = this._pool.getProvider(provName);
    if (!prov) return 0;
    // Use scorer's _getModelLimits which does proper name resolution
    // (prefix matching, aliases, etc.) before falling back to provider defaults
    if (prov.scorer && typeof prov.scorer._getModelLimits === "function") {
      const limits = prov.scorer._getModelLimits(modelId);
      if (limits.tpm > 0) return limits.tpm;
    }
    return 0;
  }

  /**
   * Filter raw upstream models to chat-capable models only.
   *
   * @param {object[]} models - Raw model objects from /models
   * @param {string} providerName
   * @returns {object[]} - Filtered models with _cleanId attached
   */
  _filterModels(models, providerName) {
    // Build set of all IDs for dedup checks
    const allIds = new Set(models.map(m => (m.id || "").replace(/^models\//, "")));

    return models.filter(m => {
      const rawId = m.id || "";
      const cleanId = rawId.replace(/^models\//, "");
      const idLower = cleanId.toLowerCase();

      // Skip non-chat model types
      if (NON_CHAT_RE.test(idLower)) return false;
      if (IMAGE_RE.test(idLower)) return false;
      if (SPECIAL_RE.test(idLower)) return false;

      // Skip -latest aliases when base model exists
      if (/-latest$/.test(idLower)) return false;

      // Skip versioned duplicates: model-001 when model exists
      const deVersioned = cleanId.replace(/-\d{3}$/, "");
      if (deVersioned !== cleanId && allIds.has(deVersioned)) return false;

      // Skip small models: <4B params parsed from name
      // Separators: / - : (colon for Ollama's "model:30b" convention)
      const paramMatch = idLower.match(/(?:^|[/:-])(\d+(?:\.\d+)?)b(?:[^a-z]|$)/) ||
                         idLower.match(/[/:-]e(\d+(?:\.\d+)?)b(?:[^a-z]|$)/);
      if (paramMatch) {
        const params = parseFloat(paramMatch[1]);
        if (this._minParamBillions > 0 && params < this._minParamBillions) return false;
      }

      // Skip tiny context
      const ctx = m.context_window || 0;
      if (ctx > 0 && this._minContextWindow > 0 && ctx < this._minContextWindow) return false;

      // Attach clean ID for downstream use
      m._cleanId = cleanId;
      return true;
    });
  }
}

module.exports = ModelDiscovery;
