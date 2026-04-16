/**
 * FFAI OpenClaw Plugin — runtime entry.
 *
 * Provider registration (auth methods + dynamic model catalog) lives in the
 * lightweight `./provider-discovery.ts` module declared via the
 * `providerDiscoveryEntry` field in `openclaw.plugin.json`. OpenClaw loads
 * that module directly during catalog resolution without booting this full
 * plugin runtime, which is the supported pattern for provider plugins (see
 * first-party ollama/anthropic-vertex plugins for reference).
 *
 * This file exists only to register user-invocable commands:
 *   /ffai_stats        — compression & usage savings
 *   /ffai_encrypt      — generate an encrypted key import HTML page
 *   /ffai_import_keys  — import an encrypted key blob
 *
 * Env vars:  FFAI_KEY, FFAI_URL, FFAI_ADMIN_KEY
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";
import { handleFfaiStats, handleFfaiEncrypt, handleFfaiImportKeys } from "./ffai-commands.js";
import { runCompatSync } from "./compat-sync.js";

const PROVIDER_ID = "ffai";

type FfaiPluginConfig = {
  baseUrl?: string;
  favorites: string[];
};

/**
 * Normalize & validate plugin config from the SDK. The host stores config as
 * untyped JSON, so we re-validate at the boundary rather than trusting `as`.
 */
function normalizePluginConfig(raw: unknown): FfaiPluginConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const baseUrl = typeof src.baseUrl === "string" ? src.baseUrl.trim() || undefined : undefined;
  const favorites = Array.isArray(src.favorites)
    ? src.favorites.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  return { baseUrl, favorites };
}

function normalizeFfaiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function resolveFfaiBaseUrl(pluginConfig: FfaiPluginConfig): string {
  // Priority: env var > plugin config > default. Provider-config lookup is
  // only relevant to the catalog hook (in provider-discovery.ts), not to
  // plugin commands — commands always talk to the configured FFAI server.
  const envUrl = process.env.FFAI_URL?.trim();
  if (envUrl) return normalizeFfaiBaseUrl(envUrl);

  const pluginUrl = pluginConfig.baseUrl?.trim();
  if (pluginUrl) return normalizeFfaiBaseUrl(pluginUrl);

  return FFAI_DEFAULT_BASE_URL;
}

function resolveFfaiApiKey(): string | undefined {
  const envKey = process.env.FFAI_KEY?.trim();
  return envKey || undefined;
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "FFAI Provider",
  description: "Free-tier AI key-pooling proxy with multi-provider model discovery",
  register(api: OpenClawPluginApi) {
    const pluginConfig = normalizePluginConfig(api.pluginConfig);

    // Shared runtime resolver for command handlers — one place that maps
    // plugin config + env into the {baseUrl, apiKey} pair commands need.
    const runtimeFor = (): { baseUrl: string; apiKey: string | undefined } => ({
      baseUrl: resolveFfaiBaseUrl(pluginConfig),
      apiKey: resolveFfaiApiKey(),
    });

    // ── /ffai_stats command — compression stats ─────────────────────────
    api.registerCommand({
      name: "ffai_stats",
      description: "Show FFAI compression & usage stats",
      acceptsArgs: false,
      requireAuth: true,
      handler: async (_ctx: PluginCommandContext) => handleFfaiStats(runtimeFor()),
    });

    // ── /ffai_encrypt command — generate encrypted key import page ────────
    api.registerCommand({
      name: "ffai_encrypt",
      description: "Generate an encrypted key import page (ffai_encrypt.html)",
      acceptsArgs: false,
      requireAuth: true,
      handler: async (_ctx: PluginCommandContext) => {
        const { baseUrl } = runtimeFor();
        const adminKey = process.env.FFAI_ADMIN_KEY?.trim() || undefined;
        return handleFfaiEncrypt({ baseUrl, adminKey });
      },
    });

    // ── /ffai_import_keys command — process encrypted key blob ───────────
    // SECURITY: this command is user-initiated only. The plugin does NOT
    // register any hook that auto-invokes it on message content — pasted
    // `FFAI-IMPORT:` strings from untrusted sources (web pages, other users,
    // agent-read documents) must never trigger key import without an
    // explicit `/ffai_import_keys` invocation by the operator.
    api.registerCommand({
      name: "ffai_import_keys",
      description: "Import encrypted API keys from an FFAI-IMPORT blob",
      acceptsArgs: true,
      requireAuth: true,
      handler: async (ctx: PluginCommandContext) => {
        const { baseUrl } = runtimeFor();
        const blob = typeof ctx.args === "string" ? ctx.args.trim() : "";
        return handleFfaiImportKeys({ baseUrl, blob });
      },
    });

    // ── Compat-sync (fire-and-forget from register) ─────────────────────
    // Temporary workaround for upstream OpenClaw bugs (see compat-sync.ts
    // header and README). Fires exactly ONCE at gateway start: no polling,
    // no teardown.
    //
    // Why not `api.registerService()`?  Provider plugins (those declaring
    // `"providers"` in the manifest) are loaded by the gateway through a
    // deferred path where `registerService` is a no-op.  Calling
    // `runCompatSync` directly from `register()` avoids that limitation.
    // Self-disables when the native providerDiscoveryEntry path writes a
    // fresh heartbeat during this process session.  Can also be turned off
    // by setting `compatSync: false` in the plugin config.
    runCompatSync({
      config: api.config as Record<string, unknown>,
      pluginConfig: api.pluginConfig,
      logger: api.logger,
    }).catch(() => {
      // Errors are already logged inside runCompatSync; swallow the
      // rejection so it never surfaces as an unhandled promise.
    });
  },
});
