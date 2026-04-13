/**
 * ErrorParser — provider-specific 429 response body parsing.
 *
 * Each provider returns different 429 formats. This module extracts:
 * - parsedRetryMs: exact retry delay in milliseconds
 * - dailyExhausted: whether the daily quota (not just per-minute) is depleted
 * - quotaMetric: which dimension triggered the limit (requests, tokens, daily)
 *
 * Used by serve.js to pass rich context to Provider.cooldownKey().
 */

/**
 * Parse a 429 response body + headers for provider-specific rate limit info.
 *
 * @param {string} providerName - e.g., "gemini", "groq", "openai"
 * @param {string} body - Response body string
 * @param {object} headers - Response headers
 * @returns {{ parsedRetryMs: number, dailyExhausted: boolean, quotaMetric: string|null }}
 */
function parse429(providerName, body, headers) {
  const result = { parsedRetryMs: 0, dailyExhausted: false, quotaMetric: null };

  // Try provider-specific parsing
  const baseName = _resolveProvider(providerName);
  const parser = PARSERS[baseName];
  if (parser) {
    try {
      parser(body, headers, result);
    } catch {
      // Fallback to generic on parse error
    }
  }

  // Generic fallback: standard Retry-After header
  if (result.parsedRetryMs <= 0) {
    const retryAfter = headers["retry-after"];
    if (retryAfter) {
      const secs = parseFloat(retryAfter);
      if (Number.isFinite(secs) && secs > 0) {
        result.parsedRetryMs = secs * 1000;
      }
    }
    // retry-after-ms (non-standard, used by some providers)
    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs && result.parsedRetryMs <= 0) {
      const ms = parseFloat(retryAfterMs);
      if (Number.isFinite(ms) && ms > 0) {
        result.parsedRetryMs = ms;
      }
    }
  }

  // Detect daily exhaustion from very long retry-after (>5 min = likely daily)
  if (result.parsedRetryMs > 300000 && !result.dailyExhausted) {
    result.dailyExhausted = true;
  }

  return result;
}

// ── Provider-specific parsers ─────────────────────────────────────────────

const PARSERS = {
  /**
   * Gemini returns:
   * {
   *   "error": {
   *     "code": 429,
   *     "status": "RESOURCE_EXHAUSTED",
   *     "details": [{
   *       "reason": "RATE_LIMIT_EXCEEDED",
   *       "metadata": {
   *         "quota_metric": "generativelanguage.googleapis.com/generate_content_requests",
   *         "quota_limit_value": "5"
   *       }
   *     }]
   *   }
   * }
   * May also have retryDelay in some formats.
   */
  gemini(body, headers, result) {
    let parsed;
    try { parsed = JSON.parse(body); } catch { return; }

    const error = parsed?.error;
    if (!error) return;

    // Check for quota_metric to identify which limit was hit
    const details = error.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const meta = d?.metadata;
        if (meta?.quota_metric) {
          result.quotaMetric = meta.quota_metric;
          // Daily request limit hit
          if (meta.quota_metric.includes("generate_content_requests") && !meta.quota_metric.includes("per_minute")) {
            result.dailyExhausted = true;
          }
          if (meta.quota_metric.includes("per_day") || meta.quota_metric.includes("daily")) {
            result.dailyExhausted = true;
          }
        }
        // Some Gemini errors include retryDelay
        if (d?.retryDelay) {
          const match = d.retryDelay.match(/(\d+(?:\.\d+)?)\s*s/);
          if (match) result.parsedRetryMs = parseFloat(match[1]) * 1000;
        }
      }
    }

    // Also check error.message for "retryDelay" mentions
    if (error.message && result.parsedRetryMs <= 0) {
      const match = error.message.match(/retryDelay[":]*\s*(\d+(?:\.\d+)?)\s*s/i);
      if (match) result.parsedRetryMs = parseFloat(match[1]) * 1000;
    }

    // Use x-ratelimit-reset if available
    _parseResetHeader(headers, result);
  },

  /**
   * Groq returns standard headers:
   * - x-ratelimit-remaining-requests: 0
   * - x-ratelimit-remaining-tokens: 0
   * - x-ratelimit-reset-requests: 2024-01-01T00:00:00Z (or "1.3s")
   * - x-ratelimit-reset-tokens: 1.5s
   * - retry-after: 2
   */
  groq(body, headers, result) {
    // Check if daily requests are exhausted
    const remainReqs = parseInt(headers["x-ratelimit-remaining-requests"], 10);
    if (remainReqs === 0) {
      // Check if the reset time is far away (daily limit vs per-minute)
      const resetReqs = headers["x-ratelimit-reset-requests"];
      if (resetReqs) {
        const resetMs = _parseResetValue(resetReqs);
        if (resetMs > 300000) { // > 5 min = daily limit
          result.dailyExhausted = true;
          result.parsedRetryMs = resetMs;
        } else if (resetMs > 0) {
          result.parsedRetryMs = resetMs;
        }
      }
    }

    // Check token reset
    const remainTokens = parseInt(headers["x-ratelimit-remaining-tokens"], 10);
    if (remainTokens === 0 && result.parsedRetryMs <= 0) {
      const resetTokens = headers["x-ratelimit-reset-tokens"];
      if (resetTokens) {
        result.parsedRetryMs = _parseResetValue(resetTokens);
      }
    }

    result.quotaMetric = remainReqs === 0 ? "requests" : remainTokens === 0 ? "tokens" : null;
  },

  /**
   * OpenAI returns:
   * - x-ratelimit-remaining-requests / x-ratelimit-remaining-tokens
   * - x-ratelimit-reset-requests / x-ratelimit-reset-tokens (ISO timestamps or durations)
   * - Retry-After header
   * Body: { "error": { "type": "rate_limit_exceeded", "message": "..." } }
   */
  openai(body, headers, result) {
    // Parse body for type info
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.type === "rate_limit_exceeded") {
        // Check message for "daily" mentions
        const msg = parsed.error.message || "";
        if (/daily|per.day|day/i.test(msg)) {
          result.dailyExhausted = true;
        }
        result.quotaMetric = "rate_limit";
      }
    } catch {}

    // Parse reset headers
    _parseResetHeader(headers, result);
  },

  /**
   * Anthropic returns:
   * - anthropic-ratelimit-requests-limit / anthropic-ratelimit-requests-remaining
   * - anthropic-ratelimit-tokens-limit / anthropic-ratelimit-tokens-remaining
   * - retry-after (standard header)
   * Body: { "type": "error", "error": { "type": "rate_limit_error", "message": "..." } }
   */
  anthropic(body, headers, result) {
    // Parse body for rate_limit_error details
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error?.type === "rate_limit_error") {
        const msg = parsed.error.message || "";
        if (/daily|per.day|day/i.test(msg)) {
          result.dailyExhausted = true;
        }
      }
    } catch {}

    // Check Anthropic-specific headers
    const remainReqs = parseInt(headers["anthropic-ratelimit-requests-remaining"], 10);
    const remainTokens = parseInt(headers["anthropic-ratelimit-tokens-remaining"], 10);
    result.quotaMetric = remainReqs === 0 ? "requests" : remainTokens === 0 ? "tokens" : null;

    // Use standard retry-after or reset headers
    _parseResetHeader(headers, result);
  },

  /**
   * Cerebras uses day-granularity headers:
   * - x-ratelimit-remaining-requests-day
   * - x-ratelimit-remaining-tokens-minute
   * - x-ratelimit-reset-requests-day
   */
  cerebras(body, headers, result) {
    const remainDay = parseInt(headers["x-ratelimit-remaining-requests-day"], 10);
    if (remainDay === 0) {
      result.dailyExhausted = true;
      const resetDay = headers["x-ratelimit-reset-requests-day"];
      if (resetDay) {
        result.parsedRetryMs = _parseResetValue(resetDay);
      }
      result.quotaMetric = "requests_day";
      return;
    }

    const remainTokensMin = parseInt(headers["x-ratelimit-remaining-tokens-minute"], 10);
    if (remainTokensMin === 0) {
      const resetTokens = headers["x-ratelimit-reset-tokens-minute"];
      if (resetTokens) {
        result.parsedRetryMs = _parseResetValue(resetTokens);
      }
      result.quotaMetric = "tokens_minute";
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────

/** Parse a reset value that could be "1.5s", "36s", an ISO timestamp, or a Unix timestamp. */
function _parseResetValue(value) {
  if (!value) return 0;

  // Duration format: "1.5s", "36s", "100ms"
  const durMatch = value.match(/^(\d+(?:\.\d+)?)\s*(s|ms)$/i);
  if (durMatch) {
    const num = parseFloat(durMatch[1]);
    return durMatch[2].toLowerCase() === "ms" ? num : num * 1000;
  }

  // ISO timestamp or HTTP date
  const ts = Date.parse(value);
  if (Number.isFinite(ts)) {
    return Math.max(0, ts - Date.now());
  }

  // Plain number (seconds)
  const num = parseFloat(value);
  if (Number.isFinite(num) && num > 0) {
    return num > 1e10 ? Math.max(0, num - Date.now()) : num * 1000; // Unix timestamp vs seconds
  }

  return 0;
}

/** Extract retry delay from standard x-ratelimit-reset-* headers. */
function _parseResetHeader(headers, result) {
  if (result.parsedRetryMs > 0) return;

  const resetReqs = headers["x-ratelimit-reset-requests"];
  const resetTokens = headers["x-ratelimit-reset-tokens"];
  const reset = resetReqs || resetTokens;

  if (reset) {
    const ms = _parseResetValue(reset);
    if (ms > 0) result.parsedRetryMs = ms;
  }
}

/** Resolve provider name to base name for parser lookup. */
function _resolveProvider(name) {
  const lower = name.toLowerCase();
  for (const known of Object.keys(PARSERS)) {
    if (lower.startsWith(known) || lower === known) return known;
  }
  return lower;
}

module.exports = { parse429 };
