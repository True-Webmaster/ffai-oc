/**
 * FFAI OpenClaw Provider Plugin
 *
 * Registers FFAI as a provider with dynamic model discovery.
 * On each catalog refresh, fetches /models from the FFAI server and
 * registers one OpenClaw provider per FFAI backend (ffai-gemini,
 * ffai-groq, etc.) plus an optional ffai-favorites group.
 *
 * Config (in openclaw.json → plugins.entries.ffai.config):
 *   baseUrl:    FFAI server URL (default: http://127.0.0.1:8010)
 *   favorites:  Array of model IDs for the ffai-favorites group
 *
 * Env vars:  FFAI_KEY, FFAI_URL, FFAI_ADMIN_KEY
 * Auth:      API key via `openclaw configure` or FFAI_KEY env var
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildProviderReplayFamilyHooks,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyFfaiConfig } from "./onboard.js";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";
import { buildFfaiProviders, buildFfaiStaticProvider } from "./provider-catalog.js";
import { handleFfaiStats, handleFfaiEncrypt, handleFfaiImportKeys } from "./ffai-commands.js";

const PROVIDER_ID = "ffai";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

type DiscoveryResult = {
  provider?: ModelProviderConfig;
  providers?: Record<string, ModelProviderConfig>;
};

function isThenable<T = unknown>(x: unknown): x is PromiseLike<T> {
  return typeof x === "object" && x !== null && typeof (x as PromiseLike<T>).then === "function";
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

type FfaiPluginConfig = {
  baseUrl?: string;
  favorites: string[];
};

/**
 * Normalize & validate plugin config from the SDK. The host stores config as
 * untyped JSON, so we re-validate at the boundary rather than trusting `as`.
 * Invalid shapes (e.g. `favorites: "gemini-2.5-pro"`) are coerced to safe
 * defaults, not blindly accepted — iterating a string with `for..of` would
 * produce character-wise "favorites".
 */
function normalizePluginConfig(raw: unknown): FfaiPluginConfig {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const baseUrl = typeof src.baseUrl === "string" ? src.baseUrl.trim() || undefined : undefined;
  const favorites = Array.isArray(src.favorites)
    ? src.favorites.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  return { baseUrl, favorites };
}

/**
 * Collapse a URL to its canonical FFAI root form: trailing slashes and a
 * trailing `/v1` are stripped so downstream path joins don't produce `/v1/v1/...`.
 */
function normalizeFfaiBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function resolveFfaiBaseUrl(params: {
  pluginConfig: FfaiPluginConfig;
  providerConfig?: { baseUrl?: string };
  env: NodeJS.ProcessEnv;
}): string {
  // Priority: env var > plugin config > provider config > default
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
  // Priority: env var > SDK-resolved key > provider config
  const envKey = params.env.FFAI_KEY?.trim();
  if (envKey) return envKey;

  const resolved = params.resolvedApiKey;
  if (typeof resolved === "string" && resolved.trim()) return resolved.trim();

  const cfgKey = params.providerConfig?.apiKey;
  if (typeof cfgKey === "string" && cfgKey.trim()) return cfgKey.trim();

  return undefined;
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "FFAI Provider",
  description: "Free-tier AI key-pooling proxy with multi-provider model discovery",
  register(api: OpenClawPluginApi) {
    const pluginConfig = normalizePluginConfig(api.pluginConfig);

    api.registerProvider({
      id: PROVIDER_ID,
      label: "FFAI",
      docsPath: "https://github.com/truewebmaster/ffai#openclaw-plugin",
      envVars: ["FFAI_KEY", "FFAI_URL", "FFAI_ADMIN_KEY"],
      auth: [
        {
          id: "api-key",
          label: "FFAI API key",
          hint: "Key-pooling proxy for free-tier AI APIs",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const key = await ctx.prompter.prompt({
              message: "Enter your FFAI API key (from FFAI .env file)",
              type: "password",
            });
            if (!key?.trim()) {
              throw new Error("FFAI API key is required");
            }

            // If the user has configured favorites, promote the first one
            // to the agent default so onboarding ends with a usable model
            // selection. The ref points at the ffai-favorites virtual
            // group, which discovery will populate on the next refresh.
            const preferredModelRef = pluginConfig.favorites[0]
              ? `ffai-favorites/${pluginConfig.favorites[0]}`
              : undefined;
            // Use the same baseUrl resolver as discovery so env/plugin
            // config wins over the hard-coded default even on first run.
            // ProviderAuthContext doesn't expose env, so fall back to
            // process.env — onboarding runs in-process under the host.
            const baseUrl = resolveFfaiBaseUrl({ pluginConfig, env: process.env });
            const config = applyFfaiConfig(ctx.config, { preferredModelRef, baseUrl });
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
              configPatch: config,
            };
          },
        },
      ],

      // ── Dynamic model discovery ─────────────────────────────────────
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.ffai;

          const baseUrl = resolveFfaiBaseUrl({
            pluginConfig,
            providerConfig: explicit as { baseUrl?: string } | undefined,
            env: ctx.env,
          });

          // The SDK may return the resolved key synchronously or as a Promise
          // depending on host version — await only if thenable.
          const rawResolved = ctx.resolveProviderApiKey(PROVIDER_ID);
          const resolvedSlot = isThenable(rawResolved) ? await rawResolved : rawResolved;
          const apiKey = resolveFfaiApiKey({
            env: ctx.env,
            resolvedApiKey: (resolvedSlot as { apiKey?: string } | undefined)?.apiKey,
            providerConfig: explicit as { apiKey?: unknown } | undefined,
          });

          // If the user has hand-populated models.providers.ffai.models, honour
          // it as an override but still attempt live discovery afterwards — a
          // single stale entry must not permanently freeze the catalog.
          const explicitOverride: DiscoveryResult["provider"] | undefined =
            Array.isArray(explicit?.models) && explicit!.models.length > 0
              ? {
                  ...explicit,
                  baseUrl: `${baseUrl}/v1`,
                  api: (explicit as { api?: string }).api ?? "openai-completions",
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
            // Unexpected thrown error (e.g. programmer bug). fetchFfaiModels
            // itself catches network/SSRF/abort into a status field, so this
            // path should be rare. Log and fall through — never wipe on throw.
            ctx.logger?.warn?.(`[ffai] discovery threw: ${describeError(err)}`);
          }

          if (fetched) {
            if (fetched.unresolvedFavorites.length > 0) {
              ctx.logger?.warn?.(
                `[ffai] favorites not found in discovered catalog: ${fetched.unresolvedFavorites.join(", ")}`,
              );
            }

            // Wipe-protection: only publish discovery results when we actually
            // have providers. An empty/http_error/unreachable result must not
            // overwrite the live catalog — a transient FFAI restart or a 5xx
            // should never erase provider state users are mid-conversation on.
            // This is the same invariant FFAI's own openclaw-sync enforces.
            if (fetched.source === "fetched" && Object.keys(fetched.providers).length > 0) {
              return { providers: fetched.providers };
            }
          }

          // Discovery produced nothing usable. Preference order:
          //   1. User-provided explicit override — real models, keep it.
          //   2. Existing provider config in openclaw.json — return null
          //      to preserve whatever's already there (wipe protection).
          //   3. No prior config at all — publish the static empty-models
          //      shell so the provider slot exists; first successful
          //      discovery will fill it in.
          if (explicitOverride) return { provider: explicitOverride };
          if (explicit) return null;
          return { provider: buildFfaiStaticProvider(baseUrl) };
        },
      },

      wizard: {
        setup: {
          choiceId: "ffai-api-key",
          choiceLabel: "FFAI API key",
          groupId: "ffai",
          groupLabel: "FFAI",
          groupHint: "Free-tier AI key-pooling proxy",
          methodId: "api-key",
        },
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
    });

    // Shared runtime resolver for command handlers — keeps commands DRY and
    // makes process.env fallback explicit in one place.
    const runtimeFor = (): { baseUrl: string; apiKey: string | undefined } => ({
      baseUrl: resolveFfaiBaseUrl({ pluginConfig, env: process.env }),
      apiKey: resolveFfaiApiKey({ env: process.env }),
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
  },
});
