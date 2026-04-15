/**
 * FFAI model discovery — fetches models from the FFAI /models endpoint and
 * converts them to OpenClaw ModelDefinitionConfig format.
 *
 * Design notes:
 *   - Every boundary (HTTP response shape, FFAI model record) is re-validated
 *     at runtime. The `as` cast is reserved for places a TS-only refinement
 *     helps the type checker — never for trusting network input.
 *   - `fetchFfaiModels` distinguishes three outcomes: unreachable (network /
 *     SSRF / abort), reachable-but-error (non-ok HTTP), and reachable-ok.
 *     Wipe-protection downstream relies on that distinction.
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
  provider: string;
  owned_by?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_types?: string[];
};

const FAVORITES_SENTINEL = "favorites";

// ── SSRF policy ─────────────────────────────────────────────────────────────

export function buildFfaiSsrfPolicy(baseUrl: string): SsrFPolicy | undefined {
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

// ── Runtime validators ─────────────────────────────────────────────────────

/**
 * Validate one FFAI model record. Returns null if the record is unusable so
 * the caller can drop it rather than poisoning the catalog with half-typed
 * entries. Strings for numeric fields are coerced because some FFAI clients
 * serialize large ints as strings.
 */
function toFfaiModel(raw: unknown): FfaiModel | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || r.id.length === 0) return null;
  if (typeof r.provider !== "string" || r.provider.length === 0) return null;

  const numOrUndef = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    return undefined;
  };

  const inputTypes = Array.isArray(r.input_types)
    ? r.input_types.filter((x): x is string => typeof x === "string")
    : undefined;

  return {
    id: r.id,
    provider: r.provider,
    owned_by: typeof r.owned_by === "string" ? r.owned_by : undefined,
    context_window: numOrUndef(r.context_window),
    max_output_tokens: numOrUndef(r.max_output_tokens),
    input_types: inputTypes,
  };
}

// ── Fetch models from FFAI ──────────────────────────────────────────────────

export type FfaiFetchResult =
  | { status: "ok"; models: FfaiModel[] }
  | { status: "http_error"; code: number }
  | { status: "unreachable"; reason: string };

export async function fetchFfaiModels(
  baseUrl: string,
  apiKey: string | undefined,
): Promise<FfaiFetchResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url: `${baseUrl}/models`,
      init: {
        headers,
        signal: AbortSignal.timeout(FFAI_DISCOVERY_TIMEOUT_MS),
      },
      policy: buildFfaiSsrfPolicy(baseUrl),
      auditContext: "ffai-provider.models",
    });
    release = result.release;
    const response = result.response;

    if (!response.ok) {
      return { status: "http_error", code: response.status };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return { status: "unreachable", reason: `invalid JSON: ${describe(err)}` };
    }

    const data = (body && typeof body === "object" ? (body as Record<string, unknown>).data : undefined);
    if (!Array.isArray(data)) {
      return { status: "unreachable", reason: "response missing 'data' array" };
    }

    const models: FfaiModel[] = [];
    for (const raw of data) {
      const m = toFfaiModel(raw);
      if (!m) continue;
      if (m.provider === FAVORITES_SENTINEL) continue; // skip virtual favorites slot
      models.push(m);
    }

    return { status: "ok", models };
  } catch (err) {
    return { status: "unreachable", reason: describe(err) };
  } finally {
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return "unknown error"; }
}

// ── Convert FFAI model to OpenClaw format ───────────────────────────────────

function isReasoningModelHeuristic(modelId: string): boolean {
  return /think|reason|r1/i.test(modelId);
}

export function buildFfaiModelDefinition(model: FfaiModel): ModelDefinitionConfig {
  const supportsImage = Array.isArray(model.input_types) && model.input_types.includes("image");

  return {
    id: model.id,
    name: `${model.id} (${model.provider})`,
    reasoning: isReasoningModelHeuristic(model.id),
    input: supportsImage ? ["text", "image"] : ["text"],
    cost: FFAI_COST,
    // Use ?? not || so a legitimately-reported 0 would stay 0 (though FFAI
    // doesn't emit 0 today, it's the safer default for numeric coercion).
    contextWindow: model.context_window ?? FFAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? FFAI_DEFAULT_MAX_TOKENS,
  };
}

// ── Group models by FFAI provider ───────────────────────────────────────────

export type FfaiProviderGroup = {
  providerName: string;
  models: ModelDefinitionConfig[];
};

/**
 * Group validated models by their source provider. Groups are returned in
 * alphabetical order by provider name so downstream output (and any state
 * committed by OpenClaw) is stable across refreshes — avoids user-visible
 * churn when FFAI reshuffles its /models response.
 */
export function groupModelsByProvider(models: FfaiModel[]): FfaiProviderGroup[] {
  const byProvider = new Map<string, FfaiModel[]>();

  for (const model of models) {
    // Skip virtual "bare provider name" entries — e.g. an item with id=="groq"
    // and no metadata is the server echoing the provider slug, not a real model.
    if (model.id === model.provider && model.context_window === undefined) continue;

    const existing = byProvider.get(model.provider) ?? [];
    existing.push(model);
    byProvider.set(model.provider, existing);
  }

  const providerNames = Array.from(byProvider.keys()).sort();
  return providerNames.map((name) => ({
    providerName: name,
    models: (byProvider.get(name) ?? []).map(buildFfaiModelDefinition),
  }));
}

// ── Build favorites group ───────────────────────────────────────────────────

export type FavoritesResolution = {
  models: ModelDefinitionConfig[];
  missing: string[]; // favorite IDs that didn't resolve to any known model
};

export function buildFavoritesGroup(
  favorites: readonly string[],
  allModels: readonly FfaiModel[],
): FavoritesResolution {
  if (favorites.length === 0) return { models: [], missing: [] };

  const modelIndex = new Map<string, FfaiModel>();
  for (const m of allModels) {
    if (!modelIndex.has(m.id)) modelIndex.set(m.id, m);
  }

  const models: ModelDefinitionConfig[] = [];
  const missing: string[] = [];
  for (const favId of favorites) {
    const source = modelIndex.get(favId);
    if (source) {
      models.push(buildFfaiModelDefinition(source));
    } else {
      missing.push(favId);
    }
  }

  return { models, missing };
}
