/**
 * FFAI onboarding — applies FFAI config to openclaw.json during setup.
 */
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { FFAI_DEFAULT_BASE_URL } from "./defaults.js";

export const FFAI_DEFAULT_MODEL_REF = "ffai-gemini/gemini-2.5-pro";

export function applyFfaiProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };

  // Add default favorite model to the allowlist
  models[FFAI_DEFAULT_MODEL_REF] = {
    ...models[FFAI_DEFAULT_MODEL_REF],
    alias: models[FFAI_DEFAULT_MODEL_REF]?.alias ?? "FFAI",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: "ffai",
    api: "openai-completions",
    baseUrl: `${FFAI_DEFAULT_BASE_URL}/v1`,
    catalogModels: [],
  });
}

export function applyFfaiConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyFfaiProviderConfig(cfg),
    FFAI_DEFAULT_MODEL_REF,
  );
}
