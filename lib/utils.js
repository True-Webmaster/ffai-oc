/**
 * Shared utility functions for the FFAI engine.
 */

/**
 * Estimate input tokens from an OpenAI-format request body.
 * Rough heuristic: ~4 chars per token for English text.
 *
 * @param {string|Buffer} body - Raw request body
 * @returns {number} Estimated token count
 */
function estimateInputTokens(body) {
  if (!body || body.length === 0) return 0;
  try {
    const p = JSON.parse(typeof body === "string" ? body : body.toString());
    if (!Array.isArray(p.messages)) return 0;
    let chars = 0;
    for (const msg of p.messages) {
      if (typeof msg.content === "string") chars += msg.content.length;
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") chars += part.length;
          else if (part?.text) chars += part.text.length;
          else if (part?.image_url) chars += 1000; // ~256 tokens for small image
        }
      }
    }
    return Math.max(1, Math.ceil(chars / 4));
  } catch {
    return 0;
  }
}

/**
 * Calculate exponential backoff delay.
 * @param {number} attempt   - Zero-based attempt index
 * @param {number} [base=100]   - Base delay ms
 * @param {number} [cap=2000]   - Maximum delay ms
 * @returns {number} Delay in ms
 */
function backoffDelay(attempt, base = 100, cap = 2000) {
  return Math.min(base * Math.pow(2, attempt), cap);
}

/**
 * Today's UTC date as YYYY-MM-DD.
 * @returns {string}
 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Format milliseconds as human-readable uptime.
 * @param {number} ms
 * @returns {string}
 */
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Build collision-safe short display IDs for a set of keys.
 * @param {string[]} keys
 * @returns {Map<string, string>}
 */
function buildKeyIds(keys) {
  const ids = new Map();
  for (let len = 4; len <= 12; len++) {
    ids.clear();
    const suffixes = keys.map(k => k.slice(-len));
    const unique = new Set(suffixes).size === keys.length;
    if (unique || len === 12) {
      keys.forEach((k, i) => ids.set(k, "..." + suffixes[i]));
      break;
    }
  }
  if (ids.size !== keys.length) {
    ids.clear();
    keys.forEach((k, i) => ids.set(k, `...${k.slice(-4)}#${i}`));
  }
  return ids;
}

module.exports = {
  estimateInputTokens,
  backoffDelay,
  todayKey,
  formatUptime,
  buildKeyIds,
};
