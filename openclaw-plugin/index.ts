/**
 * FFAI OpenClaw Provider Plugin
 *
 * Registers FFAI as a provider with dynamic model discovery.
 * On each catalog refresh, fetches /models from the FFAI server and
 * registers one OpenClaw provider per FFAI backend (ffai-gemini,
 * ffai-groq, etc.) plus an optional ffai-favorites group.
 *
 * Config (in openclaw.json → plugins.ffai):
 *   baseUrl:    FFAI server URL (default: http://127.0.0.1:8010)
 *   favorites:  Array of model IDs for the ffai-favorites group
 *
 * Auth:
 *   FFAI_KEY env var or API key via `openclaw configure`
 */
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { applyFfaiConfig, FFAI_DEFAULT_MODEL_REF } from "./onboard.js";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";
import { buildFfaiProviders, buildFfaiStaticProvider } from "./provider-catalog.js";
import { handleFfaiStats, handleFfaiImport, handleFfaiImportKeys } from "./ffai-commands.js";

const PROVIDER_ID = "ffai";
const OPENAI_COMPATIBLE_REPLAY_HOOKS = buildProviderReplayFamilyHooks({
  family: "openai-compatible",
});

type FfaiPluginConfig = {
  baseUrl?: string;
  favorites?: string[];
};

function resolveFfaiBaseUrl(params: {
  pluginConfig: FfaiPluginConfig;
  providerConfig?: { baseUrl?: string };
  env: NodeJS.ProcessEnv;
}): string {
  // Priority: env var > plugin config > provider config > default
  const envUrl = params.env.FFAI_URL?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");

  const pluginUrl = params.pluginConfig.baseUrl?.trim();
  if (pluginUrl) return pluginUrl.replace(/\/+$/, "");

  const provUrl = params.providerConfig?.baseUrl?.trim();
  if (provUrl) return provUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

  return FFAI_DEFAULT_BASE_URL;
}

function resolveFfaiApiKey(params: {
  env: NodeJS.ProcessEnv;
  resolvedApiKey?: string;
  providerConfig?: { apiKey?: unknown };
}): string | undefined {
  // Priority: env var > resolved key > provider config
  const envKey = params.env.FFAI_KEY?.trim();
  if (envKey) return envKey;

  if (params.resolvedApiKey?.trim()) return params.resolvedApiKey;

  const cfgKey = params.providerConfig?.apiKey;
  if (typeof cfgKey === "string" && cfgKey.trim()) return cfgKey;

  return undefined;
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "FFAI Provider",
  description: "Free-tier AI key-pooling proxy with multi-provider model discovery",
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as FfaiPluginConfig;

    // ── Agent prompt injection — teach the agent about FFAI-IMPORT blobs ──
    api.registerHook("before_prompt_build", () => {
      return {
        appendSystemContext: [
          "## FFAI Key Import",
          "When a user pastes a string starting with `FFAI-IMPORT:` followed by a base64 blob,",
          "run the command `/ffai_import_keys` with the full blob as the argument.",
          "Do NOT ask questions — just run the command immediately.",
          "Example: if the user pastes `FFAI-IMPORT:eyJhbGci...`, run `/ffai_import_keys FFAI-IMPORT:eyJhbGci...`",
        ].join("\n"),
      };
    }, { name: "ffai-import-hint" });

    api.registerProvider({
      id: PROVIDER_ID,
      label: "FFAI",
      docsPath: "https://github.com/truewebmaster/ffai#openclaw-plugin",
      envVars: ["FFAI_KEY"],
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

            const config = applyFfaiConfig(ctx.config);
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

          const apiKey = resolveFfaiApiKey({
            env: ctx.env,
            resolvedApiKey: ctx.resolveProviderApiKey(PROVIDER_ID).apiKey,
            providerConfig: explicit as { apiKey?: unknown } | undefined,
          });

          const hasExplicitModels =
            Array.isArray(explicit?.models) && explicit!.models.length > 0;
          if (hasExplicitModels && explicit) {
            return {
              provider: {
                ...explicit,
                baseUrl: `${baseUrl}/v1`,
                api: explicit.api ?? "openai-completions",
                apiKey: apiKey ?? "ffai-local",
              },
            };
          }

          const favorites = pluginConfig.favorites;

          try {
            const result = await buildFfaiProviders({
              baseUrl,
              apiKey,
              favorites,
            });

            if (Object.keys(result.providers).length === 0) {
              if (!apiKey) return null;
              return { provider: buildFfaiStaticProvider(baseUrl) };
            }

            return { providers: result.providers };
          } catch {
            if (!apiKey) return null;
            return { provider: buildFfaiStaticProvider(baseUrl) };
          }
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
        /\bffai\b.*(?:context|too large|token)/i.test(errorMessage) ||
        /\brequest_too_large\b/i.test(errorMessage),

      resolveSyntheticAuth: ({ providerConfig }) => {
        const hasConfig =
          Boolean(providerConfig?.baseUrl?.trim()) ||
          (Array.isArray(providerConfig?.models) && providerConfig!.models.length > 0);
        if (!hasConfig) return undefined;
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

    // ── /ffai_stats command — compression stats ─────────────────────────
    api.registerCommand({
      name: "ffai_stats",
      description: "Show FFAI compression & usage stats",
      acceptsArgs: false,
      requireAuth: true,

      handler: async (_ctx: PluginCommandContext) => {
        const baseUrl = resolveFfaiBaseUrl({
          pluginConfig,
          providerConfig: undefined,
          env: process.env,
        });

        const apiKey = resolveFfaiApiKey({
          env: process.env,
          resolvedApiKey: undefined,
          providerConfig: undefined,
        });

        return handleFfaiStats({ baseUrl, apiKey });
      },
    });

    // ── /ffai_encrypt command — generate encrypted key import page ────────
    api.registerCommand({
      name: "ffai_encrypt",
      description: "Generate an encrypted key import page (ffai_encrypt.html)",
      acceptsArgs: false,
      requireAuth: true,

      handler: async (_ctx: PluginCommandContext) => {
        const baseUrl = resolveFfaiBaseUrl({
          pluginConfig,
          providerConfig: undefined,
          env: process.env,
        });

        const adminKey = process.env.FFAI_ADMIN_KEY?.trim();

        return handleFfaiImport({ baseUrl, adminKey });
      },
    });

    // ── /ffai_import_keys command — process encrypted key blob ───────────
    api.registerCommand({
      name: "ffai_import_keys",
      description: "Import encrypted API keys from an FFAI-IMPORT blob",
      acceptsArgs: true,
      requireAuth: true,

      handler: async (ctx: PluginCommandContext) => {
        const baseUrl = resolveFfaiBaseUrl({
          pluginConfig,
          providerConfig: undefined,
          env: process.env,
        });

        const blob = ctx.args?.trim() ?? "";

        return handleFfaiImportKeys({ baseUrl, blob });
      },
    });
  },
});
