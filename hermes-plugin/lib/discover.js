/**
 * FFAI discovery — fetch /models to enumerate which backends are live
 * and which deserve a custom_providers entry.
 *
 * Returns a list of provider names (e.g. ["gemini", "groq"]) whose model
 * catalog is currently non-empty. Hermes itself fetches models on demand
 * from <base_url>/v1/models, so the plugin doesn't need to embed a model
 * list — it just needs to point Hermes at one base_url per provider.
 *
 * Hardening:
 *   - URL validated and pinned (no scheme/credentials/query smuggling).
 *   - Cloud metadata hosts and link-local IPs blocked.
 *   - Response body capped at MAX_RESPONSE_BYTES (default 10 MB).
 *   - Timeout configurable; AbortController explicitly cleaned up.
 */
import {
  parseBaseUrl,
  buildEndpointUrl,
  assertNotMetadataEndpoint,
  readBoundedText,
  FfaiNetError,
} from "./net.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

async function fetchJsonBounded(url, apiKey, signal, maxBytes) {
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const resp = await fetch(url, { headers, signal });
  if (!resp.ok) {
    // Drain (bounded) so the connection is released back to the pool.
    try { await readBoundedText(resp, 64 * 1024); } catch { /* drain best-effort */ }
    throw new Error(`HTTP ${resp.status} from ${url}`);
  }
  const text = await readBoundedText(resp, maxBytes);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err.message ?? err}`);
  }
}

export async function discoverProviders({
  baseUrl,
  apiKey,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!baseUrl) throw new Error("discoverProviders: baseUrl is required");

  // Validate the configured base URL up front. Any rejection here is a
  // configuration error, not a runtime fetch failure — surface it as
  // such so the CLI exits non-zero with a clear message.
  let parsed;
  try {
    parsed = parseBaseUrl(baseUrl);
    await assertNotMetadataEndpoint(parsed);
  } catch (err) {
    if (err instanceof FfaiNetError) {
      return { providers: [], source: "blocked", error: err.message };
    }
    throw err;
  }

  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  const modelsUrl = buildEndpointUrl(base, "/models");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // /models is the authoritative source — providers without a populated
    // catalog are uninteresting (no models means Hermes would render an
    // empty submenu).
    const modelsResp = await fetchJsonBounded(modelsUrl, apiKey, controller.signal, maxResponseBytes);
    const models = Array.isArray(modelsResp?.data) ? modelsResp.data : [];

    // `favorites` is a virtual group on the FFAI side — its `/favorites/v1/*`
    // route doesn't exist (the OpenClaw plugin points its favorites entry at
    // the root auto-route instead). Hermes users have their own favorites
    // mechanism, so skip the virtual group rather than emit a broken entry.
    const RESERVED_PROVIDERS = new Set(["favorites"]);

    const byProvider = new Map();
    for (const m of models) {
      const prov = typeof m?.provider === "string" ? m.provider : null;
      if (!prov || RESERVED_PROVIDERS.has(prov)) continue;
      byProvider.set(prov, (byProvider.get(prov) ?? 0) + 1);
    }

    const providers = [...byProvider.entries()]
      .filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, modelCount: count }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { providers, source: "fetched" };
  } catch (err) {
    if (err?.name === "AbortError") return { providers: [], source: "timeout" };
    if (err instanceof FfaiNetError) return { providers: [], source: "blocked", error: err.message };
    return { providers: [], source: "error", error: err.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sanitize an FFAI provider name into a Hermes custom_providers `name`.
 * Hermes references custom providers via `custom:<name>:<model>` in slash
 * commands, so the name must round-trip through colon-delimited parsing
 * cleanly. Non-alphanumerics collapse to dashes; leading/trailing dashes
 * stripped.
 */
export function sanitizeProviderName(raw) {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}
