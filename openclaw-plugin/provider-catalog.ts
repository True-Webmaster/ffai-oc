/**
 * FFAI provider catalog builder.
 *
 * Fetches the FFAI /models endpoint and emits one OpenClaw provider per FFAI
 * backend (ffai-gemini, ffai-groq, …) plus an optional ffai-favorites virtual
 * provider. The builder exists as a separate module so `index.ts` can stay
 * focused on plugin wiring — discovery logic, validation, and OpenClaw shape
 * construction all live here.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildFavoritesGroup,
  fetchFfaiModels,
  groupModelsByProvider,
} from "./models.js";

const PROVIDER_PREFIX = "ffai-";
const FAVORITES_KEY = `${PROVIDER_PREFIX}favorites`;

export type FfaiCatalogResult = {
  providers: Record<string, ModelProviderConfig>;
  /** Favorite IDs that didn't resolve to any discovered model. */
  unresolvedFavorites: string[];
  /** Provider names that were dropped because they collide with the reserved "favorites" key. */
  droppedProviders: string[];
  /** Raw status from the fetch — lets the caller make wipe-protection choices. */
  source: "fetched" | "empty" | "http_error" | "unreachable";
};

/**
 * Sanitize an FFAI provider name into something safe to use as a key inside
 * OpenClaw's provider map. Non-alphanumerics collapse to dashes so names with
 * slashes, spaces, or unicode don't produce malformed keys downstream.
 */
function sanitizeProviderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/**
 * Fetch from FFAI and build OpenClaw provider configs for each backend.
 *
 * IMPORTANT: Callers must implement wipe protection — when `providers` is
 * empty, do NOT overwrite previously-known catalog state. This function is
 * intentionally pure: it reports what FFAI returned; the decision of whether
 * to trust a zero-provider result against the live catalog belongs upstream.
 */
export async function buildFfaiProviders(params: {
  baseUrl: string;
  apiKey: string | undefined;
  favorites?: readonly string[];
}): Promise<FfaiCatalogResult> {
  const { baseUrl, apiKey, favorites = [] } = params;
  const resolvedKey = apiKey ?? "ffai-local";

  const fetchResult = await fetchFfaiModels(baseUrl, apiKey);
  if (fetchResult.status === "unreachable") {
    return { providers: {}, unresolvedFavorites: [], droppedProviders: [], source: "unreachable" };
  }
  if (fetchResult.status === "http_error") {
    return { providers: {}, unresolvedFavorites: [], droppedProviders: [], source: "http_error" };
  }

  const { models } = fetchResult;
  if (models.length === 0) {
    return { providers: {}, unresolvedFavorites: [], droppedProviders: [], source: "empty" };
  }

  const groups = groupModelsByProvider(models);
  const providers: Record<string, ModelProviderConfig> = {};
  const droppedProviders: string[] = [];
  // Track sanitized-key counts so collisions get a numeric disambiguator
  // (`-2`, `-3`, …) rather than being merged into the first provider's
  // baseUrl — merging silently routed the second provider's models to the
  // first provider's URL on the FFAI side, which 404s every completion.
  const keyCount = new Map<string, number>();

  for (const group of groups) {
    if (group.models.length === 0) continue;
    const baseKey = `${PROVIDER_PREFIX}${sanitizeProviderKey(group.providerName)}`;
    if (baseKey === FAVORITES_KEY) {
      droppedProviders.push(group.providerName);
      continue; // reserve for the virtual group
    }
    const seen = keyCount.get(baseKey) ?? 0;
    keyCount.set(baseKey, seen + 1);
    const providerKey = seen === 0 ? baseKey : `${baseKey}-${seen + 1}`;

    // Dedupe by model id within this provider — FFAI sometimes echoes the
    // same model under multiple aliases, and OpenClaw routes by id, so
    // duplicates are at best UX noise and at worst non-deterministic.
    const seenIds = new Set<string>();
    const uniqueModels = group.models.filter((m) => {
      const id = (m as { id?: unknown }).id;
      if (typeof id !== "string" || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    if (uniqueModels.length === 0) continue;

    // URL-encode the provider segment — FFAI allows arbitrary provider
    // names in its /models response and we must not blindly splice
    // unicode/spaces into a URL path. The original (un-sanitized) name is
    // used so FFAI's routing matches what its /models response declared.
    providers[providerKey] = {
      baseUrl: `${baseUrl}/${encodeURIComponent(group.providerName)}/v1`,
      api: "openai-completions",
      apiKey: resolvedKey,
      models: uniqueModels,
    };
  }

  // Build favorites virtual provider last so it can never be clobbered by a
  // real backend that happens to produce the same key.
  let unresolvedFavorites: string[] = [];
  if (favorites.length > 0) {
    const favResolution = buildFavoritesGroup(favorites, models);
    unresolvedFavorites = favResolution.missing;
    if (favResolution.models.length > 0) {
      providers[FAVORITES_KEY] = {
        baseUrl: `${baseUrl}/v1`,
        api: "openai-completions",
        apiKey: resolvedKey,
        models: favResolution.models,
      };
    }
  }

  return { providers, unresolvedFavorites, droppedProviders, source: "fetched" };
}

/**
 * Build a static provider config used as a last-resort fallback when FFAI is
 * unreachable and no explicit user-provided config exists. Callers still need
 * wipe protection — a static empty-models provider must only replace nothing,
 * never a healthy previously-discovered catalog.
 */
export function buildFfaiStaticProvider(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: [],
  };
}
