/**
 * FFAI catalog-sync — populates `openclaw.json` with the ffai-* provider
 * catalog at gateway start.
 *
 * ## Why this exists
 *
 * OpenClaw plugins normally publish their model catalog through the
 * `providerDiscoveryEntry` hook: the host loads the entry module, calls
 * `catalog.run` periodically, and writes the result into the agent's
 * `models.json`. That hook does not currently fire for plugins that combine
 * `providerDiscoveryEntry` with a runtime entry that registers slash commands
 * (the dispatch path filters out one or the other). Filing one upstream
 * issue closed; the underlying chicken-and-egg between command registration
 * and catalog dispatch persists, and we cannot wait for it.
 *
 * Instead, this module runs from inside the plugin's `register()` and writes
 * the discovered catalog directly into `openclaw.json` — the same shape the
 * host would have written if its dispatch had reached us. From the gateway's
 * perspective, the on-disk state is identical to what native discovery would
 * have produced. From everyone else's perspective, FFAI models show up in
 * `/models` and the plugin works.
 *
 * Fires exactly once per gateway start. When FFAI is briefly unreachable at
 * boot, a bounded backoff retry keeps trying for ~5 minutes before giving
 * up and waiting for the next gateway restart. No periodic refresh — the
 * catalog stays as written until the next gateway boot or until you change
 * config and trigger a config-reload.
 *
 * ## Wipe protection
 *
 * Only writes when `buildFfaiProviders` returns `source: "fetched"` with a
 * non-empty providers map. Empty / http_error / unreachable results never
 * overwrite the live `openclaw.json` catalog — a transient FFAI restart or
 * 5xx must not erase provider state mid-conversation.
 *
 * ## Allowlist sync
 *
 * OpenClaw's `/models` only lists model refs in `agents.defaults.models`
 * when that map is non-empty. Catalog-sync ADDS discovered ffai model refs
 * to the allowlist so newly added providers (e.g. sambanova) appear
 * automatically. It never removes — manually curated entries are preserved.
 *
 * ## Auth scope
 *
 * Catalog-only. The plugin's `resolveSyntheticAuth` hook synthesises an
 * api-key credential from `FFAI_KEY` plus the populated baseUrl, so
 * completions work without writing auth profiles here.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildFfaiProviders } from "./provider-catalog.js";
import {
  FFAI_DEFAULT_BASE_URL,
  FFAI_PROVIDER_ID,
  normalizeFfaiBaseUrl,
  normalizePluginConfig,
} from "./defaults.js";

const PROVIDER_ID = FFAI_PROVIDER_ID;
const PROVIDER_PREFIX = "ffai-";

// Module-level guard. `syncHasFired` flips to true on a successful sync
// (or on intentional config-disable) and stays true for the lifetime of
// the gateway process — there is no value in re-running once we've written
// the catalog. `syncInFlight` prevents concurrent runs while the in-progress
// retry loop is still scheduling timers.
let syncHasFired = false;
let syncInFlight = false;

// Retry tuning. Discovery against a freshly-booted FFAI sometimes fails
// because the gateway races FFAI's listen-ready (especially under Docker /
// systemd parallel start). The backoff covers ~5 minutes total, after which
// the operator gets a single warn line and we wait for the next gateway
// restart to retry.
const RETRY_DELAYS_MS = [
  5_000,    // 5s
  10_000,   // 15s
  30_000,   // 45s
  60_000,   // 1m45s
  120_000,  // 3m45s
  120_000,  // 5m45s
] as const;

export type CatalogSyncLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type CatalogSyncPluginConfig = {
  baseUrl?: string;
  favorites: readonly string[];
  catalogSync: boolean;
};

// ── openclaw.json I/O ───────────────────────────────────────────────────────

function resolveOpenclawConfigPath(workspaceDir: string | undefined): string {
  const base = workspaceDir ?? path.join(os.homedir(), ".openclaw");
  return path.join(base, "openclaw.json");
}

type OpenclawConfigLike = {
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
  agents?: {
    defaults?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
};

export async function readOpenclawConfig(
  configPath: string,
  logger?: CatalogSyncLogger,
): Promise<OpenclawConfigLike | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    // File missing or unreadable — expected on first run.
    const code = (err as { code?: string })?.code;
    if (code !== "ENOENT") {
      logger?.warn?.(`[ffai] could not read ${configPath}: ${code ?? "unknown"}`);
    }
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as OpenclawConfigLike;
    logger?.warn?.(`[ffai] ${configPath} contains non-object JSON — treating as missing`);
  } catch {
    logger?.warn?.(`[ffai] ${configPath} contains invalid JSON (corrupted?) — treating as missing`);
  }
  return undefined;
}

export async function writeOpenclawConfigAtomic(configPath: string, next: unknown): Promise<void> {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, configPath);
}

// ── Catalog merge ──────────────────────────────────────────────────────────
//
// Preserves non-ffai providers untouched and replaces the full set of
// `ffai-*` provider keys with whatever discovery produced. Same shape the
// native discovery hook would have produced — no schema drift.

export function mergeFfaiProvidersIntoConfig(
  config: OpenclawConfigLike,
  ffaiProviders: Record<string, ModelProviderConfig>,
): { next: OpenclawConfigLike; changed: boolean } {
  const existing = config.models?.providers ?? {};
  const nextProviders: Record<string, ModelProviderConfig> = {};

  for (const [key, value] of Object.entries(existing)) {
    // The "ffai" root provider (the shell used by synthetic auth) is
    // preserved as-is: its baseUrl is set during onboarding, and the
    // catalog sync has nothing to say about it. Only the discovered
    // `ffai-*` provider groups are replaced.
    if (key === PROVIDER_ID || !key.startsWith(PROVIDER_PREFIX)) {
      nextProviders[key] = value;
    }
  }
  for (const [key, value] of Object.entries(ffaiProviders)) {
    nextProviders[key] = value;
  }

  const changed = JSON.stringify(existing) !== JSON.stringify(nextProviders);
  if (!changed) return { next: config, changed: false };

  const next: OpenclawConfigLike = {
    ...config,
    models: {
      ...(config.models ?? {}),
      providers: nextProviders,
    },
  };
  return { next, changed: true };
}

// ── Allowlist sync ────────────────────────────────────────────────────────
//
// `agents.defaults.models` is OpenClaw's allowlist: when non-empty, only
// listed model refs appear in `/models`. Add discovered ffai-* model refs
// so newly added providers (e.g. sambanova) appear automatically. ADD-only
// — never removes — so manually curated entries (or entries from other
// providers) are preserved.

export function syncFfaiAllowlist(
  config: OpenclawConfigLike,
  ffaiProviders: Record<string, ModelProviderConfig>,
): { next: OpenclawConfigLike; added: number } {
  const allowlist = config.agents?.defaults?.models;
  // No allowlist → all catalog models show by default; nothing to manage.
  if (!allowlist || Object.keys(allowlist).length === 0) {
    return { next: config, added: 0 };
  }

  let added = 0;
  const nextAllowlist = { ...allowlist };
  for (const [providerKey, providerCfg] of Object.entries(ffaiProviders)) {
    if (!providerKey.startsWith(PROVIDER_PREFIX)) continue;
    const models = providerCfg.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      const id = typeof model === "object" && model && "id" in model
        ? (model as { id: string }).id
        : undefined;
      if (!id) continue;
      const ref = `${providerKey}/${id}`;
      if (!(ref in nextAllowlist)) {
        nextAllowlist[ref] = {};
        added++;
      }
    }
  }

  if (added === 0) return { next: config, added: 0 };

  const next: OpenclawConfigLike = {
    ...config,
    agents: {
      ...(config.agents ?? {}),
      defaults: {
        ...(config.agents?.defaults ?? {}),
        models: nextAllowlist,
      },
    },
  };
  return { next, added };
}

// ── Config normalization ──────────────────────────────────────────────────
// Base normalization (baseUrl, favorites) lives in defaults.ts. This layer
// adds the `catalogSync` toggle. Accepts the legacy `compatSync` key as an
// alias so existing user configs continue to work.

export function normalizeCatalogSyncConfig(raw: unknown): CatalogSyncPluginConfig {
  const base = normalizePluginConfig(raw);
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Default: ON. The catalog hook still doesn't fire upstream for our case,
  // so this is the only path that populates the catalog. Operators who
  // truly want it off can set `catalogSync: false` (or the legacy
  // `compatSync: false` key — same thing).
  let catalogSync: boolean = true;
  if (src.catalogSync === false) catalogSync = false;
  else if (src.compatSync === false) catalogSync = false;
  return { ...base, catalogSync };
}

export function resolveCatalogSyncBaseUrl(params: {
  pluginConfig: CatalogSyncPluginConfig;
  env: NodeJS.ProcessEnv;
}): { baseUrl: string; explicitlySet: boolean } {
  // We track `explicitlySet` to gate the auto-flip below. The rule is
  // narrower than "operator wrote a value somewhere" — `openclaw configure`
  // writes `baseUrl: "http://127.0.0.1:8010"` into pluginConfig during
  // onboarding, which would falsely flag "explicit" if we just looked for
  // any non-empty value. Operators who want the default with auto-flip
  // would have to manually delete the field, which is a footgun.
  //
  // So: only treat the URL as explicit when EITHER:
  //   - it came from FFAI_URL env (env vars are always operator intent), or
  //   - it's a non-loopback address (no benefit to auto-flipping a
  //     non-loopback URL — auto-flip exists specifically to escape
  //     loopback for Discord visibility)
  // Otherwise it's effectively the default and auto-flip can apply.
  const envUrl = params.env.FFAI_URL?.trim();
  if (envUrl) return { baseUrl: normalizeFfaiBaseUrl(envUrl), explicitlySet: true };

  const pluginUrl = params.pluginConfig.baseUrl?.trim();
  if (pluginUrl) {
    const normalized = normalizeFfaiBaseUrl(pluginUrl);
    let host: string | null = null;
    try { host = new URL(normalized).hostname; } catch { /* malformed — fall through */ }
    const isLoopbackPluginUrl = host !== null && isLoopbackHost(host);
    return { baseUrl: normalized, explicitlySet: !isLoopbackPluginUrl };
  }

  return { baseUrl: FFAI_DEFAULT_BASE_URL, explicitlySet: false };
}

// ── Tailscale auto-detect ─────────────────────────────────────────────────
//
// OpenClaw's Discord channel plugin hides providers whose baseUrl looks
// like loopback (see openclaw/openclaw#35516). When the operator hasn't
// explicitly set FFAI_URL and FFAI is reachable on a Tailscale interface,
// we publish the Tailscale URL instead of 127.0.0.1 so Discord stops
// hiding the catalog.
//
// Safety: we ONLY flip when the Tailscale URL is verified reachable. If
// FFAI is bound to loopback only (FFAI_BIND=127.0.0.1 default), the probe
// fails and we keep using loopback — auto-flip would otherwise break every
// completion request.

const TAILSCALE_CGNAT_RE = /^100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./;

export function findTailscaleIp(): string | undefined {
  let interfaces: ReturnType<typeof os.networkInterfaces>;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    return undefined;
  }
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      if (addr.family !== "IPv4") continue;
      if (TAILSCALE_CGNAT_RE.test(addr.address)) return addr.address;
    }
  }
  return undefined;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h === "::1" || h === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

async function probeReachable(url: string, timeoutMs: number): Promise<boolean> {
  // Plain `fetch` with an AbortController — no need for SSRF guard here:
  // the caller passes a URL we constructed from a Tailscale interface, not
  // operator-supplied input.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${url}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type DetectedBaseUrl = {
  baseUrl: string;
  source: "explicit" | "loopback" | "tailscale-flipped";
  detail?: string;
};

/**
 * Returns the baseUrl that catalog-sync should publish, after considering
 * Tailscale availability.
 *
 * Decision tree:
 *   - Operator explicitly set FFAI_URL or pluginConfig.baseUrl → use that (no flip)
 *   - Resolved baseUrl is non-loopback → use that (already explicit enough)
 *   - Resolved baseUrl is loopback AND Tailscale interface exists AND
 *     FFAI is reachable on the Tailscale IP → flip to Tailscale URL
 *   - Otherwise → keep loopback
 */
export async function resolveDetectedBaseUrl(params: {
  resolved: { baseUrl: string; explicitlySet: boolean };
  probeTimeoutMs?: number;
}): Promise<DetectedBaseUrl> {
  const { resolved } = params;
  const probeTimeoutMs = params.probeTimeoutMs ?? 2000;

  if (resolved.explicitlySet) {
    return { baseUrl: resolved.baseUrl, source: "explicit" };
  }

  let parsed: URL;
  try {
    parsed = new URL(resolved.baseUrl);
  } catch {
    return { baseUrl: resolved.baseUrl, source: "loopback", detail: "unparseable URL" };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { baseUrl: resolved.baseUrl, source: "loopback" };
  }

  const tailscaleIp = findTailscaleIp();
  if (!tailscaleIp) {
    return { baseUrl: resolved.baseUrl, source: "loopback", detail: "no Tailscale interface" };
  }

  const candidate = `${parsed.protocol}//${tailscaleIp}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  const reachable = await probeReachable(candidate, probeTimeoutMs);
  if (!reachable) {
    return {
      baseUrl: resolved.baseUrl,
      source: "loopback",
      detail: `Tailscale found (${tailscaleIp}) but FFAI not reachable there — set FFAI_BIND=0.0.0.0 to expose FFAI on Tailscale`,
    };
  }

  return {
    baseUrl: candidate,
    source: "tailscale-flipped",
    detail: `auto-flipped from ${resolved.baseUrl} (Discord-friendly)`,
  };
}

export function resolveCatalogSyncApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const envKey = env.FFAI_KEY?.trim();
  return envKey || undefined;
}

// ── Service entry ──────────────────────────────────────────────────────────

export type CatalogSyncStartContext = {
  /** Full OpenClaw config (or compatible subset). The shim casts internally to access `models.providers`. */
  config: OpenclawConfigLike | Record<string, unknown>;
  /** Plugin-specific config (baseUrl, favorites, catalogSync). When provided, takes precedence over reading from `config.plugins.entries.ffai.config`. */
  pluginConfig?: unknown;
  workspaceDir?: string;
  /** Service-managed scratch dir (unused). */
  stateDir?: string;
  logger?: CatalogSyncLogger;
  env?: NodeJS.ProcessEnv;
};

/**
 * Run the catalog sync exactly once. Called fire-and-forget from `register()`
 * in `index.ts`. Also serves as the unit-testable entry point.
 *
 * On a transient FFAI failure (network error, empty result, http_error)
 * a bounded backoff retry keeps trying — see `RETRY_DELAYS_MS`. After all
 * retries exhaust, a single warn line is logged and the function returns;
 * the next sync attempt would require a gateway restart.
 */
export async function runCatalogSync(ctx: CatalogSyncStartContext): Promise<void> {
  // Re-entry guard: config writes can trigger gateway reloads that re-call
  // register() → runCatalogSync(). Both flags must be checked because a
  // retry loop may still be sleeping when the next register() fires.
  if (syncHasFired || syncInFlight) return;
  syncInFlight = true;

  const logger = ctx.logger;
  const env = ctx.env ?? process.env;

  // Resolve plugin config. Provider plugins get loaded through a deferred
  // path where api.pluginConfig may only contain schema defaults (not the
  // full user config). Read openclaw.json on disk as the authoritative source.
  const cfgPath = resolveOpenclawConfigPath(ctx.workspaceDir);
  const cfgOnDisk = await readOpenclawConfig(cfgPath, logger);
  const diskPluginConfig = (cfgOnDisk as { plugins?: { entries?: Record<string, { config?: unknown }> } })
    ?.plugins?.entries?.[PROVIDER_ID]?.config;
  const raw = (diskPluginConfig && typeof diskPluginConfig === "object")
    ? diskPluginConfig
    : ctx.pluginConfig;
  const pluginConfig = normalizeCatalogSyncConfig(raw);

  logger?.info?.(
    `[ffai] catalog-sync config: baseUrl=${pluginConfig.baseUrl ?? "(default)"}, favorites=${pluginConfig.favorites.length}, catalogSync=${pluginConfig.catalogSync}`,
  );

  if (!pluginConfig.catalogSync) {
    logger?.info?.("[ffai] catalog-sync disabled by plugin config (catalogSync=false)");
    syncHasFired = true; // intentional config — no retry
    syncInFlight = false;
    return;
  }

  const resolved = resolveCatalogSyncBaseUrl({ pluginConfig, env });
  const detected = await resolveDetectedBaseUrl({ resolved });
  if (detected.source === "tailscale-flipped") {
    logger?.info?.(`[ffai] catalog-sync: ${detected.detail}; using ${detected.baseUrl}`);
  } else if (detected.detail) {
    logger?.info?.(`[ffai] catalog-sync: ${detected.detail}`);
  }
  const baseUrl = detected.baseUrl;
  const apiKey = resolveCatalogSyncApiKey(env);

  // Retry loop: try once immediately, then after each delay in
  // RETRY_DELAYS_MS. A successful sync flips syncHasFired and exits.
  const totalAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1];
      logger?.info?.(
        `[ffai] catalog-sync: retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${totalAttempts})`,
      );
      await sleep(delayMs);
    }

    const outcome = await attemptCatalogSync({
      baseUrl,
      apiKey,
      favorites: pluginConfig.favorites,
      cfgPath,
      logger,
    });

    if (outcome === "success" || outcome === "fatal") {
      syncHasFired = true;
      syncInFlight = false;
      return;
    }
    // outcome === "transient" → fall through to next retry iteration
  }

  logger?.warn?.(
    `[ffai] catalog-sync: gave up after ${totalAttempts} attempts — catalog left as-is. ` +
    "Restart the gateway after FFAI is reachable.",
  );
  syncInFlight = false;
  // Intentionally do NOT set syncHasFired — operators sometimes restart FFAI
  // shortly after the gateway, and we want to allow another sync if a
  // future register() re-entry happens (e.g. config hot-reload).
}

// Outcomes:
//   "success"   — catalog written or already up-to-date; do not retry
//   "fatal"     — config disabled / config write failed; do not retry
//   "transient" — FFAI unreachable, returned http_error, or empty catalog;
//                 caller should retry
type SyncOutcome = "success" | "fatal" | "transient";

async function attemptCatalogSync(params: {
  baseUrl: string;
  apiKey: string | undefined;
  favorites: readonly string[];
  cfgPath: string;
  logger: CatalogSyncLogger | undefined;
}): Promise<SyncOutcome> {
  const { baseUrl, apiKey, favorites, cfgPath, logger } = params;

  let fetched;
  try {
    fetched = await buildFfaiProviders({ baseUrl, apiKey, favorites });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[ffai] catalog-sync: discovery threw — ${msg}`);
    return "transient";
  }

  // Wipe protection: only sync on a populated, fetched result.
  if (fetched.source !== "fetched" || Object.keys(fetched.providers).length === 0) {
    logger?.info?.(
      `[ffai] catalog-sync: discovery returned no providers (source=${fetched.source}, providers=${Object.keys(fetched.providers).length})`,
    );
    return "transient";
  }

  if (fetched.droppedProviders.length > 0) {
    logger?.warn?.(
      `[ffai] catalog-sync: provider(s) dropped (name collides with reserved "favorites" key): ${fetched.droppedProviders.join(", ")}`,
    );
  }
  if (fetched.unresolvedFavorites.length > 0) {
    logger?.warn?.(
      `[ffai] catalog-sync: favorites not found in discovered catalog: ${fetched.unresolvedFavorites.join(", ")}`,
    );
  }

  const onDisk = await readOpenclawConfig(cfgPath, logger);
  if (!onDisk) {
    logger?.warn?.(`[ffai] catalog-sync: could not read ${cfgPath} — skipping write`);
    return "transient";
  }

  const { next: afterProviders, changed: providersChanged } = mergeFfaiProvidersIntoConfig(
    onDisk,
    fetched.providers,
  );

  // Sync the allowlist after providers so newly added providers contribute
  // their model refs.
  const { next: afterAllowlist, added: allowlistAdded } = syncFfaiAllowlist(
    afterProviders,
    fetched.providers,
  );

  if (!providersChanged && allowlistAdded === 0) {
    logger?.info?.("[ffai] catalog-sync: on-disk catalog already matches discovery — no write");
    return "success";
  }

  try {
    await writeOpenclawConfigAtomic(cfgPath, afterAllowlist);
    const parts: string[] = [];
    if (providersChanged) parts.push(`${Object.keys(fetched.providers).length} ffai-* providers`);
    if (allowlistAdded > 0) parts.push(`${allowlistAdded} model refs to allowlist`);
    logger?.info?.(`[ffai] catalog-sync: wrote ${parts.join(" + ")} to ${cfgPath}`);
    return "success";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`[ffai] catalog-sync: failed to write ${cfgPath}: ${msg}`);
    // Write failures are typically permission issues, not transient. Don't
    // burn the retry budget on something a backoff won't fix.
    return "fatal";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
