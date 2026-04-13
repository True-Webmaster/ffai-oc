/**
 * DeprecationTracker — detects and tracks deprecated/decommissioned models.
 *
 * When an upstream provider returns 404 or 400 with deprecation-related
 * keywords, the model is marked as deprecated. This prevents the key from
 * being penalized (it's not a key error) and allows the /models endpoint
 * to filter out stale entries.
 *
 * Zero dependencies. In-memory only (resets on restart).
 */

const DEPRECATION_KEYWORDS_404 = [
  "no longer available",
  "deprecated",
  "decommissioned",
  "has been removed",
  "sunset",
  "not found",
];

const DEPRECATION_KEYWORDS_400 = [
  "model not found",
  "invalid model",
];

class DeprecationTracker {
  /**
   * @param {object} [opts]
   * @param {object} [opts.logger] - Logger with .log(), .warn(), .error()
   */
  constructor(opts = {}) {
    this.logger = opts.logger || console;
    /** @type {Map<string, { provider: string, detectedAt: number, message: string }>} */
    this._deprecated = new Map();
  }

  /**
   * Check if a response indicates model deprecation.
   * Returns true if deprecated (caller should NOT count as key error).
   *
   * @param {number} statusCode - HTTP status code
   * @param {string} responseBody - Response body as string
   * @param {string} model - Model name from the request
   * @param {string} provider - Provider name
   * @returns {boolean} true if model was detected as deprecated
   */
  check(statusCode, responseBody, model, provider) {
    if (!model) return false;

    const bodyLower = (responseBody || "").toLowerCase();
    let matched = false;

    if (statusCode === 404) {
      matched = DEPRECATION_KEYWORDS_404.some(kw => bodyLower.includes(kw));
    } else if (statusCode === 400) {
      matched = DEPRECATION_KEYWORDS_400.some(kw => bodyLower.includes(kw));
    }

    if (!matched) return false;

    // Already known — don't double-log
    if (this._deprecated.has(model)) return true;

    const message = responseBody.length > 200
      ? responseBody.slice(0, 200) + "..."
      : responseBody;

    this._deprecated.set(model, {
      provider,
      detectedAt: Date.now(),
      message,
    });

    this.logger.warn(`[ffai:deprecation] Model "${model}" (${provider}) detected as deprecated: ${message}`);
    return true;
  }

  /**
   * Check if a model is known to be deprecated.
   * @param {string} model
   * @returns {boolean}
   */
  isDeprecated(model) {
    return this._deprecated.has(model);
  }

  /**
   * Get all deprecated models.
   * @returns {Object.<string, { provider: string, detectedAt: number, message: string }>}
   */
  getAll() {
    const result = {};
    for (const [model, info] of this._deprecated) {
      result[model] = { ...info };
    }
    return result;
  }
}

module.exports = DeprecationTracker;
