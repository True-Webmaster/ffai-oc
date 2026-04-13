/**
 * FFAI model discovery — fetches models from the FFAI /models endpoint
 * and converts them to OpenClaw ModelDefinitionConfig format.
 */
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  FFAI_COST,
  FFAI_DEFAULT_CONTEXT_WINDOW,
  FFAI_DEFAULT_MAX_TOKENS,
  FFAI_DISCOVERY_TIMEOUT_MS,
} from "./defaults.js";

// ── FFAI /models response types ─────────────────────────────────────────────

export type FfaiModel = {
  id: string;
  object: string;
  owned_by: string;
  provider: string;
  context_window?: number;
  max_output_tokens?: number;
  input_types?: string[];
  _source_provider?: string; // present on favorites
};

type FfaiModelsResponse = {
  object: "list";
  data: FfaiModel[];
};

// ── SSRF policy ─────────────────────────────────────────────────────────────

export function buildFfaiSsrFPolicy(baseUrl: string): SsrFPolicy | undefined {
  try {
    const parsed = new URL(baseUrl);
    return {
      allowedHostnames: [parsed.hostname],
      hostnameAllowlist: [parsed.hostname],
    };
  } catch {
    return undefined;
  }
}

// ── Fetch models from FFAI ──────────────────────────────────────────────────

export async function fetchFfaiModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<{ reachable: boolean; models: FfaiModel[] }> {
  try {
    const headers: Record<string, string> = {
      "Accept": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const { response, release } = await fetchWithSsrFGuard({
      url: `${baseUrl}/models`,
      init: {
        headers,
        signal: AbortSignal.timeout(FFAI_DISCOVERY_TIMEOUT_MS),
      },
      policy: buildFfaiSsrFPolicy(baseUrl),
      auditContext: "ffai-provider.models",
    });
    try {
      if (!response.ok) {
        return { reachable: true, models: [] };
      }
      const data = (await response.json()) as FfaiModelsResponse;
      const models = (data.data ?? []).filter(
        (m) => m.id && m.provider !== "favorites",
      );
      return { reachable: true, models };
    } finally {
      await release();
    }
  } catch {
    return { reachable: false, models: [] };
  }
}

// ── Convert FFAI model to OpenClaw format ───────────────────────────────────

function isReasoningModelHeuristic(modelId: string): boolean {
  return /think|reason|r1/i.test(modelId);
}

export function buildFfaiModelDefinition(model: FfaiModel): ModelDefinitionConfig {
  const supportsImage =
    Array.isArray(model.input_types) && model.input_types.includes("image");

  return {
    id: model.id,
    name: `${model.id} (${model.provider})`,
    reasoning: isReasoningModelHeuristic(model.id),
    input: supportsImage ? ["text", "image"] : ["text"],
    cost: FFAI_COST,
    contextWindow: model.context_window || FFAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens || FFAI_DEFAULT_MAX_TOKENS,
  };
}

// ── Group models by FFAI provider ───────────────────────────────────────────

export type FfaiProviderGroup = {
  providerName: string;
  models: ModelDefinitionConfig[];
};

export function groupModelsByProvider(models: FfaiModel[]): FfaiProviderGroup[] {
  const byProvider = new Map<string, FfaiModel[]>();

  for (const model of models) {
    const prov = model.provider || model.owned_by || "unknown";
    // Skip virtual provider entries (bare provider-name models with no metadata)
    if (model.id === prov && !model.context_window) continue;

    const existing = byProvider.get(prov) ?? [];
    existing.push(model);
    byProvider.set(prov, existing);
  }

  const groups: FfaiProviderGroup[] = [];
  for (const [providerName, provModels] of byProvider) {
    groups.push({
      providerName,
      models: provModels.map(buildFfaiModelDefinition),
    });
  }

  return groups;
}

// ── Build favorites group ───────────────────────────────────────────────────

export function buildFavoritesGroup(
  favorites: string[],
  allModels: FfaiModel[],
): ModelDefinitionConfig[] {
  if (!favorites || favorites.length === 0) return [];

  const modelIndex = new Map<string, FfaiModel>();
  for (const m of allModels) {
    if (!modelIndex.has(m.id)) {
      modelIndex.set(m.id, m);
    }
  }

  const favModels: ModelDefinitionConfig[] = [];
  for (const favId of favorites) {
    const source = modelIndex.get(favId);
    if (source) {
      favModels.push(buildFfaiModelDefinition(source));
    }
  }

  return favModels;
}
