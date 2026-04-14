/**
 * LatencyTracker — lightweight per-key latency recorder with bounded memory.
 *
 * Uses a circular buffer (last N measurements per key) to keep memory bounded.
 * All percentile calculations are done on-read, not on-write.
 * Zero-allocation when idle (no timers, no background work).
 */

const DEFAULT_BUFFER_SIZE = 100;

class LatencyTracker {
  /**
   * @param {number} [bufferSize=100] - Max measurements per key (circular buffer)
   */
  constructor(bufferSize, maxModels) {
    this._bufferSize = bufferSize || DEFAULT_BUFFER_SIZE;
    this._maxModels = maxModels || 200; // Cap per-model maps to prevent unbounded growth
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._keys = new Map();
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._ttft = new Map(); // Time-to-first-token buffers (streaming only)
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._perToken = new Map(); // Per-token latency buffers (latencyMs / completionTokens)

    // Per-model tracking (aggregates across keys for the same model)
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._models = new Map();
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._modelTtft = new Map();
    /** @type {Map<string, { buf: number[], pos: number, count: number }>} */
    this._modelPerToken = new Map();
  }

  /**
   * Record a single latency measurement for a key.
   * @param {string} key - Key identifier
   * @param {number} durationMs - Latency in milliseconds
   * @param {object} [opts] - Optional metadata
   * @param {number} [opts.ttftMs] - Time to first token (streaming only)
   * @param {number} [opts.completionTokens] - Output tokens for per-token normalization
   */
  record(key, durationMs, opts) {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;

    this._recordToBuffer(this._keys, key, durationMs);

    // TTFT tracking for streaming
    if (opts?.ttftMs != null && Number.isFinite(opts.ttftMs) && opts.ttftMs >= 0) {
      this._recordToBuffer(this._ttft, key, opts.ttftMs);
    }

    // Per-token normalization: latency / completionTokens
    if (opts?.completionTokens > 0 && Number.isFinite(opts.completionTokens)) {
      const perToken = durationMs / opts.completionTokens;
      this._recordToBuffer(this._perToken, key, perToken);
    }

    // Per-model tracking (when model is provided) — capped to prevent unbounded growth
    if (opts?.model) {
      this._recordToBuffer(this._models, opts.model, durationMs, this._maxModels);

      if (opts.ttftMs != null && Number.isFinite(opts.ttftMs) && opts.ttftMs >= 0) {
        this._recordToBuffer(this._modelTtft, opts.model, opts.ttftMs, this._maxModels);
      }

      if (opts.completionTokens > 0 && Number.isFinite(opts.completionTokens)) {
        const perToken = durationMs / opts.completionTokens;
        this._recordToBuffer(this._modelPerToken, opts.model, perToken, this._maxModels);
      }
    }
  }

  /** Record a value into a Map of circular buffers. Evicts oldest if over capacity. */
  _recordToBuffer(map, key, value, maxEntries) {
    let entry = map.get(key);
    if (!entry) {
      // Evict oldest entry if at capacity (FIFO via Map insertion order)
      if (maxEntries && map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
      entry = { buf: new Array(this._bufferSize), pos: 0, count: 0 };
      map.set(key, entry);
    }
    entry.buf[entry.pos] = value;
    entry.pos = (entry.pos + 1) % this._bufferSize;
    if (entry.count < this._bufferSize) entry.count++;
  }

  /**
   * Get latency stats for a single key.
   * @param {string} key
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  keyStats(key) {
    const entry = this._keys.get(key);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get aggregate latency stats across all keys.
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  providerStats() {
    return this._computeAggregateStats(this._keys);
  }

  /**
   * Get stats for all keys as a plain object (keyId -> stats).
   * @returns {Object.<string, { count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number }>}
   */
  allKeyStats() {
    const result = {};
    for (const [key, entry] of this._keys) {
      if (entry.count > 0) {
        result[key] = this._computeStats(entry);
      }
    }
    return result;
  }

  /**
   * Get TTFT stats for a single key (streaming latency).
   * @param {string} key
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  ttftStats(key) {
    const entry = this._ttft.get(key);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get aggregate TTFT stats across all keys.
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  ttftProviderStats() {
    return this._computeAggregateStats(this._ttft);
  }

  /**
   * Get per-token latency stats for a key (ms/token).
   * @param {string} key
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  perTokenStats(key) {
    const entry = this._perToken.get(key);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get aggregate per-token latency stats across all keys.
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  perTokenProviderStats() {
    return this._computeAggregateStats(this._perToken);
  }

  // ── Per-Model Stats ──────────────────────────────────────────────────────────

  /**
   * Get latency stats for a single model.
   * @param {string} model
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  modelStats(model) {
    const entry = this._models.get(model);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get TTFT stats for a single model.
   * @param {string} model
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  modelTtftStats(model) {
    const entry = this._modelTtft.get(model);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get per-token latency stats for a single model (ms/token).
   * @param {string} model
   * @returns {{ count: number, avg: number, p50: number, p95: number, p99: number, min: number, max: number } | null}
   */
  modelPerTokenStats(model) {
    const entry = this._modelPerToken.get(model);
    if (!entry || entry.count === 0) return null;
    return this._computeStats(entry);
  }

  /**
   * Get stats for all models as a plain object (modelId -> { latency, ttft, perToken }).
   * @returns {Object.<string, { latency: object|null, ttft: object|null, perToken: object|null }>}
   */
  allModelStats() {
    const result = {};
    for (const [model, entry] of this._models) {
      if (entry.count > 0) {
        result[model] = {
          latency: this._computeStats(entry),
          ttft: this.modelTtftStats(model),
          perToken: this.modelPerTokenStats(model),
        };
      }
    }
    return result;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Compute aggregate stats from a Map of circular buffers. */
  _computeAggregateStats(map) {
    if (map.size === 0) return null;
    let totalCount = 0;
    for (const entry of map.values()) totalCount += entry.count;
    if (totalCount === 0) return null;
    const merged = new Array(totalCount);
    let idx = 0;
    for (const entry of map.values()) {
      for (let i = 0; i < entry.count; i++) merged[idx++] = entry.buf[i];
    }
    return this._computeStatsFromArray(merged);
  }

  /** Compute stats from a circular buffer entry. */
  _computeStats(entry) {
    const arr = new Array(entry.count);
    for (let i = 0; i < entry.count; i++) {
      arr[i] = entry.buf[i];
    }
    return this._computeStatsFromArray(arr);
  }

  /** Compute stats from a plain array of values. */
  _computeStatsFromArray(arr) {
    arr.sort((a, b) => a - b);
    const count = arr.length;
    let sum = 0;
    for (let i = 0; i < count; i++) sum += arr[i];

    return {
      count,
      avg: Math.round(sum / count),
      p50: arr[percentileIndex(count, 50)],
      p95: arr[percentileIndex(count, 95)],
      p99: arr[percentileIndex(count, 99)],
      min: arr[0],
      max: arr[count - 1],
    };
  }
}

/** Nearest-rank percentile index. */
function percentileIndex(count, pct) {
  return Math.min(Math.ceil((pct / 100) * count) - 1, count - 1);
}

module.exports = LatencyTracker;
