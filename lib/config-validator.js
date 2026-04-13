/**
 * ConfigValidator — validates FFAI config.json structure and values.
 *
 * Catches common misconfigurations at startup rather than silently misbehaving.
 * Returns an array of { level: "error"|"warn", message } entries.
 *
 * Zero dependencies.
 */

const VALID_AUTH_SCHEMES = new Set(["bearer", "header", "query"]);

const PROVIDER_FIELDS = {
  required: ["upstream_url"],
  optional: [
    "family", "keys", "keys_var", "auth_scheme", "auth_header", "auth_query",
    "rpm_limit", "tpm_limit", "rpd_limit", "tpd_limit",
    "max_concurrent", "acquire_wait_ms", "request_timeout",
    "key_cb_threshold", "key_cb_cooldown",
    "default_cooldown", "max_cooldown",
    "retryable_statuses",
    "models", "model_limits", "model_aliases",
  ],
  numeric: [
    "rpm_limit", "tpm_limit", "rpd_limit", "tpd_limit",
    "max_concurrent", "acquire_wait_ms", "request_timeout",
    "key_cb_threshold", "key_cb_cooldown",
    "default_cooldown", "max_cooldown",
    "max_retries_429", "max_retries_5xx", "max_retries_network",
    "invalid_key_break_ms", "cb_fail_rate", "cb_min_requests", "cb_max_backoff",
  ],
};

/**
 * Validate the full config object.
 *
 * @param {object} config - Parsed config.json
 * @param {object} [env]  - Process environment (for key resolution checks)
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateConfig(config, env = process.env) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== "object") {
    errors.push("config must be a non-null object");
    return { errors, warnings };
  }

  // Top-level structure
  if (!config.providers || typeof config.providers !== "object") {
    errors.push("config.providers is required and must be an object");
    return { errors, warnings };
  }

  if (Object.keys(config.providers).length === 0) {
    warnings.push("config.providers is empty — no providers configured");
  }

  // Favorites (optional)
  if (config.favorites !== undefined) {
    if (!Array.isArray(config.favorites)) {
      errors.push("config.favorites must be an array of model ID strings");
    } else {
      for (let i = 0; i < config.favorites.length; i++) {
        const fav = config.favorites[i];
        if (typeof fav !== "string" || fav.length === 0) {
          warnings.push(`config.favorites[${i}]: expected non-empty string, got ${typeof fav} (${fav})`);
        }
      }
      // Check for duplicates
      const favSet = new Set();
      for (const fav of config.favorites) {
        if (typeof fav === "string" && favSet.has(fav)) {
          warnings.push(`config.favorites: duplicate entry "${fav}"`);
        }
        favSet.add(fav);
      }
    }
  }

  // Smush (optional)
  if (config.smush !== undefined) {
    if (typeof config.smush !== "object" || config.smush === null) {
      errors.push("config.smush must be an object if present");
    } else {
      const s = config.smush;
      for (const boolField of ["enabled", "fileCache", "cmdCompress", "summarize", "verbose"]) {
        if (s[boolField] !== undefined && typeof s[boolField] !== "boolean") {
          warnings.push(`smush.${boolField}: expected boolean, got ${typeof s[boolField]}`);
        }
      }
      if (s.summaryThreshold !== undefined) {
        if (typeof s.summaryThreshold !== "number" || s.summaryThreshold < 100) {
          warnings.push(`smush.summaryThreshold: expected number >= 100, got ${s.summaryThreshold}`);
        }
      }
    }
  }

  // Pricing (optional)
  if (config.pricing !== undefined) {
    if (typeof config.pricing !== "object" || config.pricing === null) {
      errors.push("config.pricing must be an object if present");
    } else {
      for (const [key, val] of Object.entries(config.pricing)) {
        if (typeof val !== "number" || val < 0) {
          warnings.push(`pricing.${key}: expected non-negative number, got ${typeof val} (${val})`);
        }
      }
    }
  }

  // Validate each provider
  for (const [name, pconf] of Object.entries(config.providers)) {
    const prefix = `providers.${name}`;

    if (!pconf || typeof pconf !== "object") {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    // Required fields
    if (!pconf.upstream_url || typeof pconf.upstream_url !== "string") {
      errors.push(`${prefix}.upstream_url is required and must be a non-empty string`);
    } else {
      // Validate URL format
      try {
        new URL(pconf.upstream_url);
      } catch {
        errors.push(`${prefix}.upstream_url is not a valid URL: "${pconf.upstream_url}"`);
      }
    }

    // Key source check
    const hasKeys = Array.isArray(pconf.keys) && pconf.keys.length > 0;
    const hasKeysVar = typeof pconf.keys_var === "string" && pconf.keys_var.length > 0;
    if (!hasKeys && !hasKeysVar) {
      errors.push(`${prefix}: must have either "keys" array or "keys_var" env reference`);
    } else if (hasKeysVar) {
      const envVal = env[pconf.keys_var];
      if (!envVal || envVal.trim().length === 0) {
        warnings.push(`${prefix}.keys_var="${pconf.keys_var}" — env var is empty or not set`);
      } else {
        const keyCount = envVal.split(",").filter(k => k.trim()).length;
        if (keyCount === 0) {
          warnings.push(`${prefix}.keys_var="${pconf.keys_var}" — env var contains no valid keys`);
        }
      }
    }

    // Auth scheme validation
    if (pconf.auth_scheme) {
      if (!VALID_AUTH_SCHEMES.has(pconf.auth_scheme)) {
        errors.push(`${prefix}.auth_scheme="${pconf.auth_scheme}" — must be one of: ${[...VALID_AUTH_SCHEMES].join(", ")}`);
      }
      if (pconf.auth_scheme === "header" && !pconf.auth_header) {
        errors.push(`${prefix}: auth_scheme="header" requires auth_header field`);
      }
      if (pconf.auth_scheme === "query" && !pconf.auth_query) {
        warnings.push(`${prefix}: auth_scheme="query" without auth_query — will default to "key"`);
      }
    }

    // Numeric field validation
    for (const field of PROVIDER_FIELDS.numeric) {
      if (pconf[field] !== undefined && pconf[field] !== null) {
        if (typeof pconf[field] !== "number" || !Number.isFinite(pconf[field])) {
          errors.push(`${prefix}.${field}: expected number, got ${typeof pconf[field]} (${pconf[field]})`);
        } else if (pconf[field] < 0) {
          errors.push(`${prefix}.${field}: must be non-negative, got ${pconf[field]}`);
        }
      }
    }

    // retryable_statuses validation
    if (pconf.retryable_statuses !== undefined) {
      if (!Array.isArray(pconf.retryable_statuses)) {
        errors.push(`${prefix}.retryable_statuses: must be an array`);
      } else {
        for (const s of pconf.retryable_statuses) {
          if (typeof s !== "number" || s < 100 || s > 599) {
            warnings.push(`${prefix}.retryable_statuses: invalid status code ${s}`);
          }
        }
      }
    }

    // models validation
    if (pconf.models !== undefined) {
      if (!Array.isArray(pconf.models)) {
        errors.push(`${prefix}.models: must be an array`);
      } else {
        for (const m of pconf.models) {
          if (typeof m !== "string" || m.length === 0) {
            warnings.push(`${prefix}.models: contains non-string or empty entry`);
          }
        }
      }
    }

    // model_limits validation
    if (pconf.model_limits !== undefined) {
      if (typeof pconf.model_limits !== "object" || pconf.model_limits === null) {
        errors.push(`${prefix}.model_limits: must be an object`);
      } else {
        for (const [model, limits] of Object.entries(pconf.model_limits)) {
          if (typeof limits !== "object" || limits === null) {
            warnings.push(`${prefix}.model_limits.${model}: expected object with {rpm, tpm, rpd, tpd}, got ${typeof limits}`);
          } else {
            for (const f of ["rpm", "tpm", "rpd", "tpd"]) {
              if (limits[f] !== undefined && (typeof limits[f] !== "number" || !Number.isFinite(limits[f]))) {
                warnings.push(`${prefix}.model_limits.${model}.${f}: expected number, got ${typeof limits[f]}`);
              }
            }
          }
        }
      }
    }

    // model_aliases validation
    if (pconf.model_aliases !== undefined) {
      if (typeof pconf.model_aliases !== "object" || pconf.model_aliases === null) {
        errors.push(`${prefix}.model_aliases: must be an object`);
      } else {
        for (const [alias, target] of Object.entries(pconf.model_aliases)) {
          if (typeof target !== "string" || target.length === 0) {
            warnings.push(`${prefix}.model_aliases.${alias}: target must be a non-empty string, got ${typeof target}`);
          }
        }
      }
    }

    // Logical checks
    if (pconf.max_cooldown && pconf.default_cooldown && pconf.max_cooldown < pconf.default_cooldown) {
      warnings.push(`${prefix}: max_cooldown (${pconf.max_cooldown}) < default_cooldown (${pconf.default_cooldown})`);
    }

    if (pconf.acquire_wait_ms && pconf.acquire_wait_ms > 60000) {
      warnings.push(`${prefix}.acquire_wait_ms=${pconf.acquire_wait_ms}ms is very high (>60s)`);
    }

    if (pconf.request_timeout && pconf.request_timeout > 300000) {
      warnings.push(`${prefix}.request_timeout=${pconf.request_timeout}ms is very high (>5min)`);
    }
  }

  return { errors, warnings };
}

module.exports = { validateConfig };
