/**
 * FFAI OpenClaw Plugin — runtime entry.
 *
 * Provider auth methods and the model-catalog descriptor live in the
 * lightweight `./provider-discovery.ts` module declared via the
 * `providerDiscoveryEntry` field in `openclaw.plugin.json`. The host's
 * dispatch path does not invoke `catalog.run` for plugins that also
 * register a runtime entry, so the catalog gets populated by the
 * `runCatalogSync` call further down — see `catalog-sync.ts`.
 *
 * This file is responsible for:
 *   - registering user-invocable commands (/ffai_stats, /ffai_encrypt,
 *     /ffai_import_keys)
 *   - kicking off the catalog sync at gateway start
 *
 * Env vars: FFAI_KEY, FFAI_URL, FFAI_ADMIN_KEY
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  FFAI_DEFAULT_BASE_URL,
  FFAI_PROVIDER_ID,
  normalizeFfaiBaseUrl,
  normalizePluginConfig,
  type FfaiBasePluginConfig,
} from "./defaults.js";
import {
  handleFfaiStats,
  handleFfaiEncrypt,
  handleFfaiImportKeys,
  handleFfaiDoctor,
} from "./ffai-commands.js";
import { runCatalogSync } from "./catalog-sync.js";

function resolveFfaiBaseUrl(pluginConfig: FfaiBasePluginConfig): string {
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
  id: FFAI_PROVIDER_ID,
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

    // ── /ffai_doctor command — preflight diagnostics ─────────────────────
    // Walks every install-time invariant (gateway env, FFAI reachability,
    // providers configured, keys present, catalog-sync wrote openclaw.json,
    // allowlist coverage) and prints OK/FAIL with a one-line remediation
    // hint per failure. Run this when something doesn't work and you don't
    // know which layer to debug first.
    api.registerCommand({
      name: "ffai_doctor",
      description: "Run preflight diagnostics for the FFAI plugin",
      acceptsArgs: false,
      requireAuth: true,
      handler: async (_ctx: PluginCommandContext) => {
        const { baseUrl, apiKey } = runtimeFor();
        const adminKey = process.env.FFAI_ADMIN_KEY?.trim() || undefined;
        return handleFfaiDoctor({
          baseUrl,
          apiKey,
          adminKey,
          openclawConfig: api.config,
        });
      },
    });

    // ── Catalog sync (fire-and-forget from register) ────────────────────
    // Populates `models.providers.ffai-*` and the model allowlist in
    // `openclaw.json` based on what FFAI is currently serving. The host's
    // `providerDiscoveryEntry` dispatch path does not invoke catalog.run
    // for plugins that also register a runtime entry, so this runs from
    // register() instead. Fires exactly ONCE per gateway start, with a
    // bounded backoff retry to handle the gateway-races-FFAI-startup case.
    //
    // Disable with `catalogSync: false` in the plugin config (legacy
    // `compatSync: false` is also accepted).
    //
    // See catalog-sync.ts header for the full design rationale.
    runCatalogSync({
      config: api.config as Record<string, unknown>,
      pluginConfig: api.pluginConfig,
      logger: api.logger,
    }).catch((err: unknown) => {
      // runCatalogSync's outer try/catch logs and swallows its own throws,
      // so this path is only reachable for a programmer bug (e.g. a throw
      // before the try). Surface it via the host logger rather than
      // black-holing it as an unhandled rejection.
      const msg = err instanceof Error ? err.message : String(err);
      api.logger?.error?.(`[ffai] catalog-sync crashed: ${msg}`);
    });
  },
});
