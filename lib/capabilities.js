/**
 * CapabilityStore — aggregates model capability intelligence from multiple sources.
 *
 * Ingests data from model discovery (context windows, output limits, input types),
 * response headers (learned rate limits), and actual responses (streaming support).
 * Provides query APIs for individual models, all models, or by-provider filtering.
 *
 * Bounded memory: evicts oldest entries when maxModels is exceeded.
 * Zero dependencies — pure in-memory store.
 */

class CapabilityStore {
  /**
   * @param {object} opts
   * @param {object}  [opts.logger]    - Logger with .log(), .warn() methods
   * @param {number}  [opts.maxModels] - Max model entries before LRU eviction (default: 2000)
   */
  constructor({ logger, maxModels } = {}) {
    this._logger = logger || console;
    this._maxModels = maxModels ?? 2000;
    /** @type {Map<string, { provider: string, contextWindow: number, maxOutputTokens: number, inputTypes: Set<string>, supportsStreaming: boolean|null, learnedLimits: { rpm: number|undefined, tpm: number|undefined, rpd: number|undefined }, updatedAt: number }>} */
    this._models = new Map();
  }

  /**
   * Ensure a model entry exists, creating a blank one if needed.
   * @param {string} modelId
   * @param {string} provider
   * @returns {object} the model entry
   */
  _ensure(modelId, provider) {
    let entry = this._models.get(modelId);
    if (entry) {
      // Move to end for LRU ordering (Map preserves insertion order)
      this._models.delete(modelId);
      this._models.set(modelId, entry);
      return entry;
    }
    entry = {
      provider: provider,
      contextWindow: 0,
      maxOutputTokens: 0,
      inputTypes: new Set(),
      supportsStreaming: null,
      learnedLimits: { rpm: undefined, tpm: undefined, rpd: undefined },
      updatedAt: Date.now(),
    };
    this._models.set(modelId, entry);
    this._evictIfNeeded();
    return entry;
  }

  /** Evict oldest entries when over capacity. */
  _evictIfNeeded() {
    if (this._models.size <= this._maxModels) return;
    // Map iteration is insertion-order; delete from the front (oldest)
    const excess = this._models.size - this._maxModels;
    let evicted = 0;
    for (const key of this._models.keys()) {
      if (evicted >= excess) break;
      this._models.delete(key);
      evicted++;
    }
    if (evicted > 0) {
      this._logger.log(`[ffai:capabilities] evicted ${evicted} stale model(s), size=${this._models.size}`);
    }
  }

  /** Current number of tracked models. */
  get size() {
    return this._models.size;
  }

  /**
   * Ingest capability data from model discovery.
   * Only updates fields that are non-null/non-zero.
   *
   * @param {string} modelId
   * @param {string} provider
   * @param {object} data
   * @param {number} [data.contextWindow]
   * @param {number} [data.maxOutputTokens]
   * @param {string[]} [data.inputTypes]
   */
  ingestFromDiscovery(modelId, provider, { contextWindow, maxOutputTokens, inputTypes } = {}) {
    const entry = this._ensure(modelId, provider);
    if (contextWindow) entry.contextWindow = contextWindow;
    if (maxOutputTokens) entry.maxOutputTokens = maxOutputTokens;
    if (inputTypes && inputTypes.length > 0) {
      for (const t of inputTypes) entry.inputTypes.add(t);
    }
    entry.updatedAt = Date.now();
  }

  /**
   * Ingest learned rate limits from response headers.
   *
   * @param {string} modelId
   * @param {string} provider
   * @param {object} limits
   * @param {number} [limits.rpm]
   * @param {number} [limits.tpm]
   * @param {number} [limits.rpd]
   */
  ingestFromHeaders(modelId, provider, { rpm, tpm, rpd } = {}) {
    const entry = this._ensure(modelId, provider);
    if (rpm != null) entry.learnedLimits.rpm = rpm;
    if (tpm != null) entry.learnedLimits.tpm = tpm;
    if (rpd != null) entry.learnedLimits.rpd = rpd;
    entry.updatedAt = Date.now();
  }

  /**
   * Ingest streaming support observation from a response.
   * Only flips on first observation — once set, does not change.
   *
   * @param {string} modelId
   * @param {string} provider
   * @param {object} data
   * @param {boolean} data.streaming
   */
  ingestFromResponse(modelId, provider, { streaming } = {}) {
    const entry = this._ensure(modelId, provider);
    if (entry.supportsStreaming === null && streaming != null) {
      entry.supportsStreaming = !!streaming;
    }
    entry.updatedAt = Date.now();
  }

  /**
   * Get capabilities for a specific model.
   *
   * @param {string} modelId
   * @returns {{ provider: string, contextWindow: number, maxOutputTokens: number, inputTypes: string[], supportsStreaming: boolean|null, learnedLimits: object, updatedAt: number }|null}
   */
  getModel(modelId) {
    const entry = this._models.get(modelId);
    if (!entry) return null;
    return {
      provider: entry.provider,
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
      inputTypes: Array.from(entry.inputTypes),
      supportsStreaming: entry.supportsStreaming,
      learnedLimits: { ...entry.learnedLimits },
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * Get all capabilities as a plain object (JSON-safe).
   * Converts Sets to arrays.
   *
   * @returns {Object<string, object>}
   */
  getAll() {
    const result = {};
    for (const [modelId, entry] of this._models) {
      result[modelId] = {
        provider: entry.provider,
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        inputTypes: Array.from(entry.inputTypes),
        supportsStreaming: entry.supportsStreaming,
        learnedLimits: { ...entry.learnedLimits },
        updatedAt: entry.updatedAt,
      };
    }
    return result;
  }

  /**
   * Get capabilities filtered by provider name.
   *
   * @param {string} providerName
   * @returns {Object<string, object>}
   */
  getByProvider(providerName) {
    const result = {};
    for (const [modelId, entry] of this._models) {
      if (entry.provider === providerName) {
        result[modelId] = {
          provider: entry.provider,
          contextWindow: entry.contextWindow,
          maxOutputTokens: entry.maxOutputTokens,
          inputTypes: Array.from(entry.inputTypes),
          supportsStreaming: entry.supportsStreaming,
          learnedLimits: { ...entry.learnedLimits },
          updatedAt: entry.updatedAt,
        };
      }
    }
    return result;
  }
}

module.exports = CapabilityStore;
