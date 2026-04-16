/**
 * FFAI onboarding — applies FFAI config to openclaw.json during setup.
 *
 * Runs exactly once, inside the auth.run callback when the user first pastes
 * an API key. At that point we don't yet know which models FFAI will expose
 * (discovery hasn't run), so this file intentionally avoids hard-coding a
 * default model ref. Instead it:
 *
 *   - Registers the ffai provider shell (baseUrl, api, empty catalog).
 *   - Optionally promotes a caller-supplied "preferred" model ref to the
 *     agent default if one is passed in (e.g. the first configured
 *     favorite). Callers who don't know a ref yet pass undefined and let
 *     the first discovery cycle populate the catalog.
 *
 * The previous hard-coded `ffai-gemini/gemini-2.5-pro` default broke
 * onboarding for users whose FFAI instance had no Gemini key, silently
 * leaving them on a model ref that would never resolve.
 */
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { FFAI_DEFAULT_BASE_URL, normalizeFfaiBaseUrl } from "./defaults.js";

export function applyFfaiConfig(
  cfg: OpenClawConfig,
  options: { preferredModelRef?: string; baseUrl?: string } = {},
): OpenClawConfig {
  const root = normalizeFfaiBaseUrl(options.baseUrl ?? FFAI_DEFAULT_BASE_URL);
  const withProvider = applyProviderConfigWithModelCatalog(cfg, {
    agentModels: { ...cfg.agents?.defaults?.models },
    providerId: "ffai",
    api: "openai-completions",
    baseUrl: `${root}/v1`,
    catalogModels: [],
  });
  if (!options.preferredModelRef) return withProvider;
  return applyAgentDefaultModelPrimary(withProvider, options.preferredModelRef);
}
