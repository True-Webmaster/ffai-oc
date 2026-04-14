/**
 * FreeTier — auto-applies free-tier rate limits and daily reset schedules.
 *
 * When a provider has no explicit rpm_limit/rpd_limit configured,
 * FFAI looks up known free-tier defaults for that provider and applies them.
 * This means zero-config for the most common free-tier providers.
 */
const freeTierLimits = require("./free-tier-limits.json");

/**
 * Apply free-tier defaults to a provider config if no explicit limits are set.
 * Mutates the config object in-place and returns it.
 *
 * @param {string} providerName - e.g., "gemini", "groq"
 * @param {object} config - Provider config from user's config.json
 * @returns {object} The config with defaults applied
 */
function applyFreeTierDefaults(providerName, config) {
  // Normalize provider name: "gemini-flash" → "gemini", "groq-free" → "groq"
  const baseName = _resolveProviderName(providerName);
  const tier = freeTierLimits[baseName];
  if (!tier) return config;

  const defaults = tier.defaults || {};

  // Only apply if user hasn't explicitly set limits (null/undefined means unset; 0 means unlimited)
  if (config.rpm_limit == null && defaults.rpm) config.rpm_limit = defaults.rpm;
  if (config.rpd_limit == null && defaults.rpd) config.rpd_limit = defaults.rpd;
  if (config.tpm_limit == null && defaults.tpm) config.tpm_limit = defaults.tpm;
  if (config.tpd_limit == null && defaults.tpd) config.tpd_limit = defaults.tpd;

  // Apply per-model limits if user hasn't set any
  if (!config.model_limits && tier.models) {
    config.model_limits = {};
    for (const [model, limits] of Object.entries(tier.models)) {
      config.model_limits[model] = { ...limits };
    }
  }

  // Store reset schedule for daily quota tracking
  if (tier._reset && tier._reset !== "rolling") {
    config._daily_reset = tier._reset; // e.g., "00:00 America/Los_Angeles"
  }

  return config;
}

/**
 * Get the daily reset timestamp (next reset time) for a provider.
 * Returns null if provider uses rolling windows (no fixed daily reset).
 *
 * @param {string} providerName
 * @returns {number|null} Unix timestamp of next daily reset, or null
 */
function nextDailyReset(providerName) {
  const baseName = _resolveProviderName(providerName);
  const tier = freeTierLimits[baseName];
  if (!tier || !tier._reset || tier._reset === "rolling") return null;

  return _parseResetSchedule(tier._reset);
}

/**
 * Get the ms until next daily reset.
 * @param {string} providerName
 * @returns {number|null} Milliseconds until reset, or null if rolling
 */
function msUntilDailyReset(providerName) {
  const ts = nextDailyReset(providerName);
  if (!ts) return null;
  return Math.max(0, ts - Date.now());
}

/**
 * Check if a provider has known free-tier limits.
 * @param {string} providerName
 * @returns {boolean}
 */
function isKnownFreeTier(providerName) {
  const baseName = _resolveProviderName(providerName);
  return baseName in freeTierLimits;
}

/**
 * Get the raw free-tier limits for a provider.
 * @param {string} providerName
 * @returns {object|null}
 */
function getFreeTierLimits(providerName) {
  const baseName = _resolveProviderName(providerName);
  return freeTierLimits[baseName] || null;
}

// ── Internal ────────────────────────────────────────────────────────────────

/** Resolve provider name to base name for lookup. */
function _resolveProviderName(name) {
  const lower = name.toLowerCase();
  // Exact match first
  if (freeTierLimits[lower]) return lower;
  // Prefix match: "gemini-flash" → "gemini", "groq-free" → "groq"
  for (const known of Object.keys(freeTierLimits)) {
    if (lower.startsWith(known)) return known;
  }
  return lower;
}

/**
 * Parse a reset schedule string like "00:00 America/Los_Angeles" or "00:00 UTC"
 * into the next occurrence as a Unix timestamp.
 */
function _parseResetSchedule(schedule) {
  const parts = schedule.split(" ");
  const timeParts = parts[0].split(":");
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1] || "0", 10);
  const tz = parts[1] || "UTC";

  const now = new Date();

  // Use a simple approach: calculate today's reset time, if past, use tomorrow's
  let resetDate;
  try {
    // Get current time in the target timezone
    const nowInTz = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const todayReset = new Date(nowInTz);
    todayReset.setHours(hour, minute, 0, 0);

    // Calculate offset between nowInTz and now (UTC) to convert back
    const tzOffsetMs = now.getTime() - nowInTz.getTime();

    if (nowInTz >= todayReset) {
      // Reset already happened today, next is tomorrow
      todayReset.setDate(todayReset.getDate() + 1);
    }

    resetDate = new Date(todayReset.getTime() + tzOffsetMs);
  } catch {
    // Fallback: assume UTC
    resetDate = new Date(now);
    resetDate.setUTCHours(hour, minute, 0, 0);
    if (resetDate <= now) resetDate.setUTCDate(resetDate.getUTCDate() + 1);
  }

  return resetDate.getTime();
}

module.exports = {
  applyFreeTierDefaults,
  nextDailyReset,
  msUntilDailyReset,
  isKnownFreeTier,
  getFreeTierLimits,
};
