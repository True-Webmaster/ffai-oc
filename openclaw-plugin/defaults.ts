export const FFAI_DEFAULT_BASE_URL = "http://127.0.0.1:8010";
export const FFAI_DEFAULT_CONTEXT_WINDOW = 131072;
export const FFAI_DEFAULT_MAX_TOKENS = 8192;
export const FFAI_DISCOVERY_TIMEOUT_MS = 10000;

// Zero-cost: FFAI is a free-tier key-pooling proxy, so all token costs
// are zero from the user's perspective.
export const FFAI_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

// ── Shared helpers ─────────────────────────────────────────────────────────
// These live here (not in index.ts or provider-discovery.ts) so both the
// lightweight discovery entry and the full plugin runtime share a single
// copy. `defaults.ts` has no SDK imports, keeping it safe to load from
// either path.

export const FFAI_PROVIDER_ID = "ffai";

/**
 * Strip trailing slashes and a trailing `/v1` segment so all modules
 * compare / construct URLs from the same canonical root.
 */
export function normalizeFfaiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export type FfaiBasePluginConfig = {
  baseUrl?: string;
  favorites: string[];
};

/**
 * Normalize & validate plugin config from untyped JSON. Every module that
 * reads plugin config goes through this so the coercion rules are in one
 * place.
 */
export function normalizePluginConfig(raw: unknown): FfaiBasePluginConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const baseUrl = typeof src.baseUrl === "string" ? src.baseUrl.trim() || undefined : undefined;
  const favorites = Array.isArray(src.favorites)
    ? src.favorites.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  return { baseUrl, favorites };
}
