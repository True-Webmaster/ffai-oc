/**
 * FFAI discovery — fetch /providers and /models to enumerate what backends
 * are live and which provider keys deserve a custom_providers entry.
 *
 * Returns a list of provider names (e.g. ["gemini", "groq"]) whose model
 * catalog is currently non-empty. Hermes itself fetches models on demand
 * from <base_url>/v1/models, so the plugin doesn't need to embed a model
 * list — it just needs to point Hermes at one base_url per provider.
 */
const FETCH_TIMEOUT_MS = 15_000;

async function fetchJson(url, apiKey, signal) {
  const headers = { accept: "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const resp = await fetch(url, { headers, signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
}

export async function discoverProviders({ baseUrl, apiKey } = {}) {
  if (!baseUrl) throw new Error("discoverProviders: baseUrl is required");
  const base = baseUrl.replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // /models is the authoritative source — providers without a populated
    // catalog are uninteresting (no models means Hermes would render an
    // empty submenu).
    const modelsResp = await fetchJson(`${base}/models`, apiKey, controller.signal);
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
    if (err.name === "AbortError") return { providers: [], source: "timeout" };
    return { providers: [], source: "error", error: err.message };
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
