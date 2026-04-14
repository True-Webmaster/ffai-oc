/**
 * OpenClaw Sync — Updates openclaw.json with FFAI's discovered models.
 *
 * This module is used by serve.js to automatically sync models after each
 * discovery refresh. Also used by sync-openclaw.js CLI for manual syncs.
 *
 * Zero dependencies — uses Node built-in fs/path only.
 */
const fs = require("fs");
const path = require("path");

const PROVIDER_PREFIX = "ffai-";

/**
 * Build OpenClaw provider entries from discovery data.
 *
 * @param {Map<string, { models: object[], fetchedAt: number }>} cache - Discovery cache
 * @param {string} ffaiUrl - FFAI base URL (e.g., "http://127.0.0.1:8010")
 * @returns {{ ocProviders: object, totalModels: number }}
 */
function buildProviderEntries(cache, ffaiUrl) {
  const ocProviders = {};
  let totalModels = 0;

  for (const [provName, entry] of cache) {
    if (!entry.models || entry.models.length === 0) continue;

    const ocKey = `${PROVIDER_PREFIX}${provName}`;
    const modelEntries = entry.models.map((m) => {
      const cleanId = (m.id || "").replace(/^models\//, "");
      const supportsImage = Array.isArray(m.input_types) && m.input_types.includes("image");
      const contextWindow = m.context_window || 131072;
      const maxTokens = m.max_output_tokens || 8192;

      return {
        id: cleanId,
        name: `${cleanId} (${provName})`,
        reasoning: false,
        input: supportsImage ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
      };
    });

    ocProviders[ocKey] = {
      baseUrl: `${ffaiUrl}/${provName}/v1`,
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "FFAI_KEY" },
      models: modelEntries,
    };

    totalModels += modelEntries.length;
  }

  return { ocProviders, totalModels };
}

/**
 * Write FFAI provider entries into openclaw.json (atomic).
 * Removes old ffai-* entries and replaces with current ones.
 * Also updates the model allowlist under agents.defaults.models.
 *
 * @param {string} openclawJsonPath - Path to openclaw.json
 * @param {object} ocProviders - Provider entries keyed by ffai-<name>
 * @param {object} [logger=console]
 * @returns {boolean} - true if written successfully
 */
function writeOpenclawJson(openclawJsonPath, ocProviders, logger = console) {
  let oc;
  try {
    oc = JSON.parse(fs.readFileSync(openclawJsonPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      // Create minimal skeleton if file doesn't exist yet
      logger.log(`[openclaw-sync] ${openclawJsonPath} not found, creating fresh`);
      oc = { models: { providers: {} }, agents: { defaults: { models: {} } } };
    } else {
      logger.warn(`[openclaw-sync] Cannot read ${openclawJsonPath}: ${err.message}`);
      return false;
    }
  }

  if (!oc.models) oc.models = {};
  if (!oc.models.providers) oc.models.providers = {};

  // Remove old ffai-* providers
  for (const key of Object.keys(oc.models.providers)) {
    if (key.startsWith(PROVIDER_PREFIX)) delete oc.models.providers[key];
  }
  Object.assign(oc.models.providers, ocProviders);

  // Update model allowlist
  if (!oc.agents) oc.agents = {};
  if (!oc.agents.defaults) oc.agents.defaults = {};
  if (!oc.agents.defaults.models) oc.agents.defaults.models = {};
  const allowlist = oc.agents.defaults.models;

  // Remove old ffai-* allowlist entries
  for (const key of Object.keys(allowlist)) {
    if (key.startsWith(PROVIDER_PREFIX)) delete allowlist[key];
  }

  // Add current models to allowlist
  let allowlistCount = 0;
  for (const [provKey, provData] of Object.entries(ocProviders)) {
    if (!provData || !provData.models) continue;
    for (const model of provData.models) {
      allowlist[`${provKey}/${model.id}`] = {};
      allowlistCount++;
    }
  }

  // Atomic write
  const tmp = openclawJsonPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(oc, null, 2));
  fs.renameSync(tmp, openclawJsonPath);
  logger.log(`[openclaw-sync] Updated ${openclawJsonPath} (${Object.keys(ocProviders).length} providers, ${allowlistCount} models)`);
  return true;
}

/**
 * Write per-agent models.json files with FFAI providers.
 *
 * @param {string} agentsDir - Path to agents directory (e.g., ~/.openclaw/agents)
 * @param {object} ocProviders - Provider entries keyed by ffai-<name>
 * @param {string} ffaiUrl - FFAI base URL
 * @param {object} [logger=console]
 */
function writeAgentModels(agentsDir, ocProviders, ffaiUrl, logger = console) {
  // Build agent-format providers (with compat flags)
  const agentProviders = {};
  for (const [ocKey, provData] of Object.entries(ocProviders)) {
    agentProviders[ocKey] = {
      baseUrl: provData.baseUrl,
      api: "openai-completions",
      apiKey: "FFAI_KEY",
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
      models: provData.models,
    };
  }

  try {
    const dirs = fs.readdirSync(agentsDir).filter(d => {
      try { fs.statSync(path.join(agentsDir, d, "agent")); return true; }
      catch { return false; }
    });
    for (const agentName of dirs) {
      const modelsPath = path.join(agentsDir, agentName, "agent", "models.json");
      let existing = { providers: {} };
      try {
        existing = JSON.parse(fs.readFileSync(modelsPath, "utf8"));
      } catch (err) {
        if (err.code !== "ENOENT") {
          logger.warn(`[openclaw-sync] Corrupt ${modelsPath}: ${err.message} — creating fresh`);
        }
      }
      if (!existing.providers) existing.providers = {};

      // Remove old ffai-* providers
      for (const key of Object.keys(existing.providers)) {
        if (key.startsWith(PROVIDER_PREFIX)) delete existing.providers[key];
      }
      Object.assign(existing.providers, agentProviders);

      fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
      const tmp = modelsPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
      fs.renameSync(tmp, modelsPath);
    }
    logger.log(`[openclaw-sync] Updated ${dirs.length} agent models.json files`);
  } catch (err) {
    logger.warn(`[openclaw-sync] Cannot update agent models: ${err.message}`);
  }
}

/**
 * Build a virtual "ffai-favorites" provider from favorites list.
 * Resolves each favorite model ID against the full provider set to get metadata.
 *
 * @param {string[]} favorites - Array of model IDs from config.favorites
 * @param {object} ocProviders - Already-built provider entries
 * @param {string} ffaiUrl - FFAI base URL
 * @returns {object|null} - Provider entry for ffai-favorites, or null if empty
 */
function buildFavoritesProvider(favorites, ocProviders, ffaiUrl) {
  if (!Array.isArray(favorites) || favorites.length === 0) return null;

  // Build index: modelId → { provKey, modelEntry }
  const modelIndex = new Map();
  for (const [provKey, provData] of Object.entries(ocProviders)) {
    if (!provData?.models) continue;
    for (const m of provData.models) {
      if (!modelIndex.has(m.id)) {
        modelIndex.set(m.id, { provKey, model: m });
      }
    }
  }

  const favModels = [];
  for (const favId of favorites) {
    const found = modelIndex.get(favId);
    if (found) {
      // Clone model entry, append source provider in name for clarity
      const srcProvider = found.provKey.replace(/^ffai-/, "");
      favModels.push({
        ...found.model,
        name: `${favId} (${srcProvider})`,
      });
    }
  }

  if (favModels.length === 0) return null;

  return {
    baseUrl: `${ffaiUrl}/v1`,
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "FFAI_KEY" },
    models: favModels,
  };
}

/**
 * Full sync: build entries from discovery cache and write to openclaw.json.
 *
 * @param {object} opts
 * @param {Map} opts.cache - Discovery cache (providerName → { models, fetchedAt })
 * @param {string} opts.ffaiUrl - FFAI base URL
 * @param {string} opts.openclawJson - Path to openclaw.json
 * @param {boolean} [opts.allAgents=false] - Also update per-agent models.json
 * @param {string}  [opts.agentsDir] - Path to agents directory
 * @param {string[]} [opts.favorites] - Favorite model IDs from config
 * @param {object}  [opts.logger=console]
 * @returns {boolean}
 */
function sync(opts) {
  const { cache, ffaiUrl, openclawJson, allAgents = false, agentsDir, favorites, logger = console } = opts;

  const { ocProviders, totalModels } = buildProviderEntries(cache, ffaiUrl);

  // Wipe protection
  if (totalModels === 0) {
    logger.warn("[openclaw-sync] ABORT: 0 models discovered — refusing to wipe config");
    return false;
  }

  // Build favorites virtual provider
  const favProvider = buildFavoritesProvider(favorites, ocProviders, ffaiUrl);
  if (favProvider) {
    ocProviders["ffai-favorites"] = favProvider;
    logger.log(`[openclaw-sync] Favorites: ${favProvider.models.length} models`);
  }

  logger.log(`[openclaw-sync] Syncing ${totalModels} models across ${Object.keys(ocProviders).length} providers`);

  if (!writeOpenclawJson(openclawJson, ocProviders, logger)) return false;

  if (allAgents && agentsDir) {
    writeAgentModels(agentsDir, ocProviders, ffaiUrl, logger);
  }

  return true;
}

module.exports = { sync };
