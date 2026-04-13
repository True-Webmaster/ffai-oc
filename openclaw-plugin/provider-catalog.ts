/**
 * FFAI provider catalog builder.
 *
 * Returns multiple OpenClaw providers: one per FFAI backend (ffai-gemini,
 * ffai-groq, etc.) plus an optional ffai-favorites group.
 */
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";
import {
  buildFavoritesGroup,
  fetchFfaiModels,
  groupModelsByProvider,
  type FfaiModel,
} from "./models.js";

const PROVIDER_PREFIX = "ffai-";

export type FfaiCatalogResult = {
  providers: Record<string, ModelProviderConfig>;
  totalModels: number;
};

/**
 * Fetch from FFAI and build OpenClaw provider configs for each backend.
 */
export async function buildFfaiProviders(params: {
  baseUrl: string;
  apiKey: string | undefined;
  favorites?: string[];
}): Promise<FfaiCatalogResult> {
  const { baseUrl, apiKey, favorites } = params;
  const resolvedKey = apiKey ?? "ffai-local";

  const { reachable, models } = await fetchFfaiModels(baseUrl, apiKey);
  if (!reachable || models.length === 0) {
    return { providers: {}, totalModels: 0 };
  }

  const groups = groupModelsByProvider(models);
  const providers: Record<string, ModelProviderConfig> = {};
  let totalModels = 0;

  for (const group of groups) {
    if (group.models.length === 0) continue;

    const providerKey = `${PROVIDER_PREFIX}${group.providerName}`;
    providers[providerKey] = {
      baseUrl: `${baseUrl}/${group.providerName}/v1`,
      api: "openai-completions",
      apiKey: resolvedKey,
      models: group.models,
    };
    totalModels += group.models.length;
  }

  // Build favorites virtual provider
  if (favorites && favorites.length > 0) {
    const favModels = buildFavoritesGroup(favorites, models);
    if (favModels.length > 0) {
      providers[`${PROVIDER_PREFIX}favorites`] = {
        baseUrl: `${baseUrl}/v1`,
        api: "openai-completions",
        apiKey: resolvedKey,
        models: favModels,
      };
    }
  }

  return { providers, totalModels };
}

/**
 * Build a static provider config (used when FFAI is unreachable, fallback
 * to whatever the user has manually configured in openclaw.json).
 */
export function buildFfaiStaticProvider(baseUrl: string): ModelProviderConfig {
  return {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    models: [],
  };
}
