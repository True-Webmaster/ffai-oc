/**
 * FFAI compat-sync shim — temporary workaround for upstream OpenClaw bugs
 * (see `openclaw/openclaw#65715`) that prevent `providerDiscoveryEntry`
 * plugins from loading correctly on the gateway host. Until the fix ships,
 * this shim performs the same catalog sync the native discovery hook would
 * have performed — fire-and-forget from `register()` in `index.ts`,
 * running exactly ONCE per gateway start.
 *
 * ## Design
 *
 * The shim is gated on the `compatSync` plugin config flag (default: true).
 * Turning it off is the single lever that disables the workaround when
 * upstream ships. It also disables itself automatically: before syncing,
 * it checks a heartbeat marker file written by `runFfaiCatalog` in
 * `provider-discovery.ts`. If that marker is fresh (younger than the
 * current process uptime — i.e., written during this gateway session), the
 * native discovery path is already working and the shim bails out without
 * touching openclaw.json.
 *
 * No polling loop: runs once per gateway restart, performs the sync, and
 * returns. Fire-and-forget — errors are logged and swallowed.
 *
 * ## Wipe protection
 *
 * The shim only writes when `buildFfaiProviders` returns `source: "fetched"`
 * with a non-empty providers map. Empty / http_error / unreachable results
 * must never overwrite the live openclaw.json catalog — a transient FFAI
 * restart or 5xx should not erase provider state users are mid-conversation
 * on. This mirrors the wipe-protection policy in `provider-discovery.ts`.
 *
 * ## Auth scope
 *
 * The shim is catalog-only. It does NOT write auth profiles. During the
 * upstream-broken window, users onboard by setting `FFAI_KEY` in the
 * environment — the provider's `resolveSyntheticAuth` hook then synthesizes
 * an api-key credential from the populated baseUrl + models, and completions
 * work. When upstream ships, `openclaw configure` starts working again with
 * no migration needed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { buildFfaiProviders } from "./provider-catalog.js";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";

const PROVIDER_ID = "ffai";
const PROVIDER_PREFIX = "ffai-";

// Module-level guard — prevents re-entry when the config write triggers a
// gateway reload that re-calls `register()` → `runCompatSync()`.
let syncHasFired = false;
// Heartbeat lives under `<workspaceDir>/.plugin-state/ffai-compat-sync/` so
// both the catalog hook (which gets `workspaceDir`) and the service shim
// (which also reads from workspaceDir for the openclaw.json path) address
// the same file. Service `stateDir` would be cleaner semantically, but the
// catalog hook has no access to it.
const HEARTBEAT_SUBDIR = path.join(".plugin-state", "ffai-compat-sync");
const HEARTBEAT_FILE = "catalog-heartbeat.json";

function heartbeatPathFor(workspaceDir: string | undefined): string {
  const base = workspaceDir ?? path.join(os.homedir(), ".openclaw");
  return path.join(base, HEARTBEAT_SUBDIR, HEARTBEAT_FILE);
}

export type CompatSyncLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

export type FfaiPluginConfig = {
  baseUrl?: string;
  favorites: readonly string[];
  compatSync: boolean;
};

// ── Heartbeat ───────────────────────────────────────────────────────────────
//
// The heartbeat file is the shim's self-disable signal. `runFfaiCatalog` in
// `provider-discovery.ts` writes it at the top of every catalog run. If the
// shim sees a heartbeat younger than the current process uptime, the native
// discovery path is working and the shim must not sync.

export async function readCatalogHeartbeat(workspaceDir: string | undefined): Promise<number | undefined> {
  const file = heartbeatPathFor(workspaceDir);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { writtenAt?: unknown }).writtenAt === "number") {
      return (parsed as { writtenAt: number }).writtenAt;
    }
  } catch {
    // Missing / malformed heartbeat is not an error — it just means the
    // native path has never run (or the file was nuked), and the shim
    // should proceed with the sync.
  }
  return undefined;
}

export async function writeCatalogHeartbeat(workspaceDir: string | undefined): Promise<void> {
  const file = heartbeatPathFor(workspaceDir);
  const dir = path.dirname(file);
  try {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ writtenAt: Date.now() }), "utf8");
    await fs.rename(tmp, file);
  } catch {
    // Heartbeat write is best-effort — failing here should never break the
    // catalog hook itself.
  }
}

/**
 * Decide whether the native discovery path beat us to this gateway session.
 *
 * The comparison uses process uptime: if the heartbeat was written after
 * this process started, the native hook fired during this session and the
 * shim should not sync. Otherwise the heartbeat is either stale (from a
 * prior session) or missing entirely, and the shim should proceed.
 */
export function nativeDiscoveryIsHealthy(params: {
  heartbeatWrittenAt: number | undefined;
  processStartMs: number;
}): boolean {
  if (typeof params.heartbeatWrittenAt !== "number") return false;
  return params.heartbeatWrittenAt >= params.processStartMs;
}

// ── openclaw.json I/O ───────────────────────────────────────────────────────

function resolveOpenclawConfigPath(workspaceDir: string | undefined): string {
  const base = workspaceDir ?? path.join(os.homedir(), ".openclaw");
  return path.join(base, "openclaw.json");
}

type OpenclawConfigLike = {
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
};

export async function readOpenclawConfig(configPath: string): Promise<OpenclawConfigLike | undefined> {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as OpenclawConfigLike;
  } catch {
    // Missing or unreadable config — the shim can't safely proceed. The
    // caller logs and bails.
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
// Merging preserves non-ffai providers untouched and replaces the full set
// of `ffai-*` provider keys with whatever discovery produced. This is the
// same shape the native discovery hook would produce, so there is no
// schema drift between the two paths.

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

// ── Config normalization (shared shape with index.ts / provider-discovery.ts)
//
// The shim cannot import from those files because they pull in the full
// plugin-entry runtime; duplicating the 20-line helper is cheaper than a
// shared file both sides pull in.

export function normalizeCompatSyncConfig(raw: unknown): FfaiPluginConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const baseUrl = typeof src.baseUrl === "string" ? src.baseUrl.trim() || undefined : undefined;
  const favorites = Array.isArray(src.favorites)
    ? src.favorites.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  // Default: ON. This is the workaround window. Users who know upstream is
  // fixed on their host can flip it to false to disable the shim.
  const compatSync = src.compatSync === false ? false : true;
  return { baseUrl, favorites, compatSync };
}

function normalizeFfaiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

export function resolveCompatSyncBaseUrl(params: {
  pluginConfig: FfaiPluginConfig;
  env: NodeJS.ProcessEnv;
}): string {
  const envUrl = params.env.FFAI_URL?.trim();
  if (envUrl) return normalizeFfaiBaseUrl(envUrl);
  const pluginUrl = params.pluginConfig.baseUrl?.trim();
  if (pluginUrl) return normalizeFfaiBaseUrl(pluginUrl);
  return FFAI_DEFAULT_BASE_URL;
}

export function resolveCompatSyncApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const envKey = env.FFAI_KEY?.trim();
  return envKey || undefined;
}

// ── Service entry ──────────────────────────────────────────────────────────

export type CompatSyncStartContext = {
  /** Full OpenClaw config (or compatible subset). The shim casts internally to access `models.providers`. */
  config: OpenclawConfigLike | Record<string, unknown>;
  /** Plugin-specific config (baseUrl, favorites, compatSync). When provided, takes precedence over reading from `config.plugins.entries.ffai.config`. */
  pluginConfig?: unknown;
  workspaceDir?: string;
  /** Service-managed scratch dir (not currently used; heartbeat lives under workspaceDir). */
  stateDir?: string;
  logger?: CompatSyncLogger;
  env?: NodeJS.ProcessEnv;
  /** Test seam for process start time. Defaults to Date.now() - uptime. */
  processStartMs?: number;
};

/**
 * Run the compat sync exactly once. Called fire-and-forget from `register()`
 * in `index.ts`. Also serves as the unit-testable entry point.
 */
export async function runCompatSync(ctx: CompatSyncStartContext): Promise<void> {
  // Prevent re-entry: config writes trigger gateway reloads that re-call
  // register() → runCompatSync(). One sync per process is enough.
  if (syncHasFired) return;
  syncHasFired = true;

  const logger = ctx.logger;
  const env = ctx.env ?? process.env;

  // Resolve plugin config. Provider plugins get loaded through a deferred
  // path where api.pluginConfig may only contain schema defaults (not the
  // full user config). Fall back to reading openclaw.json on disk as the
  // authoritative source.
  // Resolve plugin config. Provider plugins get loaded through a deferred
  // path where api.pluginConfig may only contain schema defaults (not the
  // full user config). Read openclaw.json on disk as the authoritative source.
  const cfgPath = resolveOpenclawConfigPath(ctx.workspaceDir);
  const cfgOnDisk = await readOpenclawConfig(cfgPath);
  const diskPluginConfig = (cfgOnDisk as { plugins?: { entries?: Record<string, { config?: unknown }> } })
    ?.plugins?.entries?.[PROVIDER_ID]?.config;
  const raw = (diskPluginConfig && typeof diskPluginConfig === "object")
    ? diskPluginConfig
    : ctx.pluginConfig;
  const pluginConfig = normalizeCompatSyncConfig(raw);

  logger?.info?.(`[ffai] compat-sync config: baseUrl=${pluginConfig.baseUrl ?? "(default)"}, favorites=${pluginConfig.favorites.length}, compatSync=${pluginConfig.compatSync}`);

  if (!pluginConfig.compatSync) {
    logger?.info?.("[ffai] compat-sync disabled by plugin config (compatSync=false)");
    return;
  }

  const processStartMs =
    typeof ctx.processStartMs === "number"
      ? ctx.processStartMs
      : Date.now() - Math.round(process.uptime() * 1000);

  const heartbeatWrittenAt = await readCatalogHeartbeat(ctx.workspaceDir);
  if (nativeDiscoveryIsHealthy({ heartbeatWrittenAt, processStartMs })) {
    logger?.info?.(
      "[ffai] native discovery path is healthy this session (fresh heartbeat) — compat-sync skipping",
    );
    return;
  }

  const baseUrl = resolveCompatSyncBaseUrl({ pluginConfig, env });
  const apiKey = resolveCompatSyncApiKey(env);

  let fetched;
  try {
    fetched = await buildFfaiProviders({
      baseUrl,
      apiKey,
      favorites: pluginConfig.favorites,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[ffai] compat-sync discovery threw: ${msg}`);
    return;
  }

  // Wipe protection: only sync on a populated fetched result. Empty /
  // http_error / unreachable must never overwrite a live catalog.
  if (fetched.source !== "fetched" || Object.keys(fetched.providers).length === 0) {
    logger?.info?.(
      `[ffai] compat-sync skipping write (source=${fetched.source}, providers=${Object.keys(fetched.providers).length})`,
    );
    return;
  }

  if (fetched.unresolvedFavorites.length > 0) {
    logger?.warn?.(
      `[ffai] compat-sync: favorites not found in discovered catalog: ${fetched.unresolvedFavorites.join(", ")}`,
    );
  }

  const configPath = resolveOpenclawConfigPath(ctx.workspaceDir);
  const onDisk = await readOpenclawConfig(configPath);
  if (!onDisk) {
    logger?.warn?.(`[ffai] compat-sync: could not read ${configPath} — skipping write`);
    return;
  }

  const { next, changed } = mergeFfaiProvidersIntoConfig(onDisk, fetched.providers);
  if (!changed) {
    logger?.info?.("[ffai] compat-sync: on-disk catalog already matches discovery — no write");
    return;
  }

  try {
    await writeOpenclawConfigAtomic(configPath, next);
    logger?.info?.(
      `[ffai] compat-sync: wrote ${Object.keys(fetched.providers).length} ffai-* providers to ${configPath}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`[ffai] compat-sync: failed to write ${configPath}: ${msg}`);
  }
}
