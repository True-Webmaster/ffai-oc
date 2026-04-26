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

export function buildFfaiSsrfPolicy(baseUrl: string): SsrFPolicy {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    // Fail closed: a malformed baseUrl must never result in an undefined
    // policy (which could be interpreted as "allow all" by the SDK).
    // Use an impossible hostname so every request is blocked.
    return { allowedHostnames: [], hostnameAllowlist: [] };
  }
  return {
    allowedHostnames: [parsed.hostname],
    hostnameAllowlist: [parsed.hostname],
  };
}

/**
 * Build the request URL for an FFAI endpoint. Pins protocol+host+port to the
 * configured baseUrl — the SDK SSRF policy is hostname-only, so a tampered
 * `baseUrl` could otherwise pivot port (e.g. 127.0.0.1:8010 → 127.0.0.1:22).
 *
 * Rejects baseUrls with non-http(s) schemes, embedded credentials, or query/
 * hash components. Returns null on any rejection so the caller can fail closed.
 */
export function buildFfaiEndpointUrl(baseUrl: string, pathname: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;
  // Compose explicitly so trailing slashes / paths in baseUrl don't get
  // truncated by `new URL(pathname, baseUrl)` semantics.
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

// Cap response body to a sane size so a malicious or misconfigured FFAI server
// can't OOM the host process at boot. 10 MB is generous for /models (real
// payloads are <100 KB) without being so small it breaks future growth.
export const FFAI_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const lenHeader = response.headers.get("content-length");
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new Error(`response body too large (${len} > ${maxBytes} bytes)`);
    }
  }
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments without a streaming body — bounded by header
    // check above; if no header, accept the small risk of buffering.
    return response.json();
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new Error(`response body too large (>${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  const text = new TextDecoder("utf-8").decode(merged);
  return JSON.parse(text);
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
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = Number(v);
      if (Number.isSafeInteger(n) && n >= 0) return n;
    }
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
  const url = buildFfaiEndpointUrl(baseUrl, "/models");
  if (!url) {
    return { status: "unreachable", reason: "invalid baseUrl (scheme/credentials/query)" };
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url,
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
      // Drain the body to release the connection back to the pool. An
      // unconsumed body in Node (undici) keeps the socket tied to this
      // response, leaking connections under sustained error conditions.
      // Bounded read so an attacker can't tie up memory via a giant 5xx body.
      try {
        const reader = response.body?.getReader();
        if (reader) {
          let drained = 0;
          while (drained < 64 * 1024) {
            const { value, done } = await reader.read();
            if (done) break;
            drained += value?.byteLength ?? 0;
          }
          try { await reader.cancel(); } catch { /* best effort */ }
        }
      } catch { /* drain best-effort */ }
      return { status: "http_error", code: response.status };
    }

    let body: unknown;
    try {
      body = await readBoundedJson(response, FFAI_MAX_RESPONSE_BYTES);
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
  // Word-boundary anchored to avoid false positives like "rethink-mini",
  // "unreasonable-v2", or "ar1t-base". Matches: "deepthink", "reasoning",
  // "o1-mini", "r1-distill", "qwq" (Qwen reasoning), "thinking".
  return /\bthink(?:ing)?\b|\breason(?:ing)?\b|\br1\b|\bo1\b|\bqwq\b/i.test(modelId);
}

export function buildFfaiModelDefinition(model: FfaiModel): ModelDefinitionConfig {
  const supportsImage = Array.isArray(model.input_types) && model.input_types.includes("image");

  return {
    id: model.id,
    name: `${model.id} (${model.provider})`,
    reasoning: isReasoningModelHeuristic(model.id),
    input: supportsImage ? ["text", "image"] : ["text"],
    cost: FFAI_COST,
    // Use || so that 0 falls through to the default — OpenClaw requires
    // contextWindow > 0 and maxTokens > 0 in its config schema.
    contextWindow: model.context_window || FFAI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens || FFAI_DEFAULT_MAX_TOKENS,
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

  // Sort by provider name first so collisions (same model ID from multiple
  // providers) resolve deterministically — alphabetical-first provider wins,
  // matching the ordering in groupModelsByProvider.
  const sorted = [...allModels].sort((a, b) => a.provider.localeCompare(b.provider));
  const modelIndex = new Map<string, FfaiModel>();
  for (const m of sorted) {
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
