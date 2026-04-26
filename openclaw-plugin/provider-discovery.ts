/**
 * FFAI provider discovery entry.
 *
 * This is the lightweight module declared via `providerDiscoveryEntry` in
 * `openclaw.plugin.json`. OpenClaw loads it *without* booting the full plugin
 * runtime, so it must not import `plugin-entry` or call any `api.*` side-effect
 * registrar. It only exports a `ProviderPlugin` descriptor — auth methods,
 * the catalog hook, and provider-level metadata — which OpenClaw merges into
 * its provider registry during catalog resolution.
 *
 * History: FFAI originally put the `discovery.run` hook inside
 * `api.registerProvider()` in `index.ts`. That hook was never invoked,
 * because without `providerDiscoveryEntry` in the manifest, OpenClaw's
 * catalog resolver has no lightweight module to load and the live plugin
 * registry is empty in short-lived CLI processes. Moving the provider
 * descriptor here is the fix — not an optional refactor.
 */
import type {
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type {
  ProviderAuthContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  FFAI_DEFAULT_BASE_URL,
  FFAI_PROVIDER_ID,
  normalizeFfaiBaseUrl,
  normalizePluginConfig,
  type FfaiBasePluginConfig,
} from "./defaults.js";
import { applyFfaiConfig } from "./onboard.js";
import { buildFfaiProviders, buildFfaiStaticProvider } from "./provider-catalog.js";

const PROVIDER_ID = FFAI_PROVIDER_ID;

const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

// ── Plugin config shape & helpers ──────────────────────────────────────────
// Shared helpers (normalizePluginConfig, normalizeFfaiBaseUrl) live in
// defaults.ts so both the discovery entry and the plugin runtime share a
// single copy. defaults.ts has no SDK imports, keeping it safe for either
// load path.

type FfaiPluginConfig = FfaiBasePluginConfig;

/**
 * Read FFAI plugin config out of a loaded OpenClawConfig. Discovery and auth
 * flows both go through this so there is one source of truth for the shape
 * coercion.
 */
function readFfaiPluginConfig(config: { plugins?: { entries?: Record<string, { config?: unknown }> } }): FfaiPluginConfig {
  const raw = config.plugins?.entries?.[PROVIDER_ID]?.config;
  return normalizePluginConfig(raw);
}

function resolveFfaiBaseUrl(params: {
  pluginConfig: FfaiPluginConfig;
  providerConfig?: { baseUrl?: string };
  env: NodeJS.ProcessEnv;
}): string {
  // Priority: env var > plugin config > provider config > default.
  // Matches the runtime resolver used by command handlers in index.ts.
  const envUrl = params.env.FFAI_URL?.trim();
  if (envUrl) return normalizeFfaiBaseUrl(envUrl);

  const pluginUrl = params.pluginConfig.baseUrl?.trim();
  if (pluginUrl) return normalizeFfaiBaseUrl(pluginUrl);

  const provUrl = params.providerConfig?.baseUrl?.trim();
  if (provUrl) return normalizeFfaiBaseUrl(provUrl);

  return FFAI_DEFAULT_BASE_URL;
}

function resolveFfaiApiKey(params: {
  env: NodeJS.ProcessEnv;
  resolvedApiKey?: string;
  providerConfig?: { apiKey?: unknown };
}): string | undefined {
  const envKey = params.env.FFAI_KEY?.trim();
  if (envKey) return envKey;

  const resolved = params.resolvedApiKey;
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();

  const cfgKey = params.providerConfig?.apiKey;
  if (typeof cfgKey === "string" && cfgKey.trim()) return cfgKey.trim();

  return undefined;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

// ── Auth: interactive API-key setup ────────────────────────────────────────

async function runFfaiApiKeyAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  const key = await ctx.prompter.text({
    message: "Enter your FFAI API key (from FFAI .env file)",
    validate: (v) => (v.trim() ? undefined : "FFAI API key is required"),
  });
  if (!key?.trim()) {
    throw new Error("FFAI API key is required");
  }

  const pluginConfig = readFfaiPluginConfig(ctx.config);
  const preferredModelRef = pluginConfig.favorites[0]
    ? `ffai-favorites/${pluginConfig.favorites[0]}`
    : undefined;
  // Auth ctx surfaces env via `ctx.env` on modern hosts; fall back to process.env
  // so older hosts keep working. Either path is in-process under the host.
  const env = ctx.env ?? process.env;
  const baseUrl = resolveFfaiBaseUrl({ pluginConfig, env });
  const configPatch = applyFfaiConfig(ctx.config, { preferredModelRef, baseUrl });

  return {
    profiles: [
      {
        profileId: "ffai:default",
        credential: {
          type: "api_key",
          provider: PROVIDER_ID,
          key: key.trim(),
        },
      },
    ],
    configPatch,
  };
}

// ── Catalog: dynamic model discovery ───────────────────────────────────────

/**
 * Validate that an override `models` array contains real model objects with
 * a string `id`. Filters out garbage so a malformed user config can't poison
 * the published catalog with primitives or nameless entries.
 */
function validateOverrideModels(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const valid = raw.filter((m) =>
    m !== null
    && typeof m === "object"
    && "id" in m
    && typeof (m as { id: unknown }).id === "string"
    && (m as { id: string }).id.length > 0);
  return valid.length > 0 ? valid : undefined;
}

async function runFfaiCatalog(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
  // This hook is registered for completeness, but the OpenClaw host's
  // dispatch path does not currently invoke catalog.run for plugins that
  // also register a runtime entry. Catalog population happens via
  // catalog-sync.ts running from inside register(). If a future host
  // version starts calling this hook, both paths will produce the same
  // openclaw.json shape.
  //
  // Outer try/catch: every helper called below operates on `unknown`-shaped
  // config from disk. A single TypeError from a malformed openclaw.json must
  // not propagate out of the hook and break OpenClaw boot — return null to
  // preserve whatever the host already has.
  const logger = (ctx as { logger?: { warn?: (msg: string) => void } }).logger;
  try {
    const pluginConfig = readFfaiPluginConfig(ctx.config);
    const explicit = ctx.config.models?.providers?.[PROVIDER_ID];

    const baseUrl = resolveFfaiBaseUrl({
      pluginConfig,
      providerConfig: explicit as { baseUrl?: string } | undefined,
      env: ctx.env,
    });

    const resolved = ctx.resolveProviderApiKey(PROVIDER_ID);
    const apiKey = resolveFfaiApiKey({
      env: ctx.env,
      resolvedApiKey: resolved?.apiKey,
      providerConfig: explicit as { apiKey?: unknown } | undefined,
    });

    // If the user has hand-populated models.providers.ffai.models, honour it
    // as an override but still attempt live discovery afterwards — a single
    // stale entry must not permanently freeze the catalog. Each override
    // entry is validated to be an object with a string id so a malformed
    // config (e.g. `models: ["gpt-4"]`) can't poison the published shape.
    const validatedOverride = validateOverrideModels((explicit as { models?: unknown })?.models);
    const explicitOverride: ModelProviderConfig | undefined = validatedOverride
      ? {
          ...(explicit as ModelProviderConfig),
          models: validatedOverride as ModelProviderConfig["models"],
          baseUrl: `${baseUrl}/v1`,
          api: ((explicit as { api?: ModelProviderConfig["api"] }).api ?? "openai-completions"),
          apiKey: apiKey ?? "ffai-local",
        }
      : undefined;

    let fetched: Awaited<ReturnType<typeof buildFfaiProviders>> | undefined;
    try {
      fetched = await buildFfaiProviders({
        baseUrl,
        apiKey,
        favorites: pluginConfig.favorites,
      });
    } catch (err) {
      // Unexpected thrown error (programmer bug). fetchFfaiModels itself
      // catches network/SSRF/abort into a status field, so this path is rare.
      logger?.warn?.(`[ffai] catalog threw: ${describeError(err)}`);
    }

    if (fetched) {
      if (fetched.droppedProviders.length > 0) {
        logger?.warn?.(
          `[ffai] provider(s) dropped (name collides with reserved "favorites" key): ${fetched.droppedProviders.join(", ")}`,
        );
      }
      if (fetched.unresolvedFavorites.length > 0) {
        logger?.warn?.(
          `[ffai] favorites not found in discovered catalog: ${fetched.unresolvedFavorites.join(", ")}`,
        );
      }

      // Wipe-protection: only publish discovery results when we actually
      // have providers. Empty/http_error/unreachable results must not
      // overwrite the live catalog — a transient FFAI restart or a 5xx
      // should never erase provider state users are mid-conversation on.
      if (fetched.source === "fetched" && Object.keys(fetched.providers).length > 0) {
        return { providers: fetched.providers };
      }
    }

    // Discovery produced nothing usable. Preference order:
    //   1. User-provided explicit override — real models, keep it.
    //   2. Existing provider config in openclaw.json — return null to
    //      preserve whatever's already there (wipe protection).
    //   3. No prior config at all — return null too: the host should keep
    //      whatever live state it has rather than receive an empty shell
    //      that might overwrite a previously-discovered catalog held only
    //      in the host's in-memory registry. catalog-sync.ts (the runtime
    //      path) is what publishes the shell on a true cold start; this
    //      hook errs on the side of preservation.
    if (explicitOverride) return { provider: explicitOverride };
    return null;
  } catch (err) {
    logger?.warn?.(`[ffai] catalog hook prelude threw: ${describeError(err)} — preserving existing catalog`);
    return null;
  }
}

// Re-export for tests / programmatic callers that only need the static shell
// (e.g. catalog-sync's first-cold-boot path).
export { buildFfaiStaticProvider };

// ── Provider descriptor (default export) ───────────────────────────────────

const ffaiProviderPlugin: ProviderPlugin = {
  id: PROVIDER_ID,
  label: "FFAI",
  docsPath: "https://github.com/True-Webmaster/ffai-oc#openclaw-plugin",
  envVars: ["FFAI_KEY", "FFAI_URL", "FFAI_ADMIN_KEY"],
  auth: [
    {
      id: "api-key",
      label: "FFAI API key",
      hint: "Key-pooling proxy for free-tier AI APIs",
      kind: "custom",
      run: runFfaiApiKeyAuth,
    },
  ],
  catalog: {
    order: "late",
    run: runFfaiCatalog,
  },

  ...OPENAI_COMPATIBLE_REPLAY_HOOKS,

  matchesContextOverflowError: ({ errorMessage }) =>
    /\brequest_too_large\b/i.test(errorMessage) ||
    /context[_\s-]?(?:window|length)/i.test(errorMessage) ||
    /\btoo[_\s-]?(?:many|large)\b.*\btokens?\b/i.test(errorMessage) ||
    /\bmax(?:imum)?\s+tokens?\s+(?:exceeded|limit)/i.test(errorMessage),

  resolveSyntheticAuth: ({ providerConfig }) => {
    const hasBaseUrl = typeof providerConfig?.baseUrl === "string"
      && providerConfig.baseUrl.trim().length > 0;
    const hasModels = Array.isArray(providerConfig?.models)
      && providerConfig.models.length > 0;
    if (!hasBaseUrl && !hasModels) return undefined;
    return {
      apiKey: "ffai-local",
      source: "models.providers.ffai (synthetic)",
      mode: "api-key",
    };
  },

  buildUnknownModelHint: () =>
    "FFAI discovers models dynamically. Ensure FFAI is running and " +
    "FFAI_KEY is set. Run `openclaw configure` or check FFAI logs.",
};

export default ffaiProviderPlugin;
export { ffaiProviderPlugin };
