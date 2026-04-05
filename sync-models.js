#!/usr/bin/env node
// sync-models.js — Fetches models from KeyMux /models and updates OpenClaw models.json
// Usage: node sync-models.js [path-to-models.json]
//
// Reads KEYMUX_URL and KEYMUX_PROXY_KEY from env (or defaults to localhost:8002).
// Merges discovered models into the existing models.json, preserving non-KeyMux providers.
//
// Context windows and max tokens are fetched dynamically from each provider's API.
// A static fallback table (MODEL_SPECS) is used only when the API doesn't provide values.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const KEYMUX_URL = (process.env.KEYMUX_URL || "http://127.0.0.1:8002").replace(/\/+$/, "");
const KEYMUX_PROXY_KEY = process.env.KEYMUX_PROXY_KEY || "";
const MODELS_JSON = process.argv[2] || path.join(process.env.HOME, ".openclaw", "agents", "main", "agent", "models.json");
const OPENCLAW_JSON = process.env.OPENCLAW_JSON || path.join(process.env.HOME, ".openclaw", "openclaw.json");

// Static fallback specs — used ONLY when the provider API doesn't return context_window
// or max_completion_tokens. Prefer dynamic values from the API.
const MODEL_SPECS_FALLBACK = {
  // Gemini (native API returns these, but fallback in case it fails)
  "gemini-2.5-flash":           { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.5-pro":             { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.0-flash":           { contextWindow: 1048576, maxTokens: 8192 },
  // Groq (API returns these, but fallback for safety)
  "qwen/qwen3-32b":             { contextWindow: 131072, maxTokens: 4096 },
};

// Provider-specific native API endpoints for fetching model details
// Used when the OpenAI-compat /models endpoint doesn't return context_window
const NATIVE_MODEL_APIS = {
  gemini: {
    // Gemini's native API returns inputTokenLimit and outputTokenLimit
    urlTemplate: (modelId) =>
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}`,
    authScheme: "query", // ?key=API_KEY
    parse: (data) => ({
      contextWindow: data.inputTokenLimit || 0,
      maxTokens: data.outputTokenLimit || 0,
    }),
  },
};

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`));
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

// Fetch model specs from a provider's native API (e.g. Gemini's /v1beta/models)
async function fetchNativeModelSpecs(provName, modelIds, apiKey) {
  const api = NATIVE_MODEL_APIS[provName];
  if (!api || !apiKey) return {};

  const specs = {};
  const batchSize = 5; // parallel requests, be gentle
  for (let i = 0; i < modelIds.length; i += batchSize) {
    const batch = modelIds.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (id) => {
      let url = api.urlTemplate(id);
      if (api.authScheme === "query") url += `?key=${apiKey}`;
      const headers = api.authScheme === "bearer" ? { authorization: `Bearer ${apiKey}` } : {};
      const data = await httpGet(url, headers);
      return { id, ...api.parse(data) };
    }));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.contextWindow > 0) {
        specs[r.value.id] = { contextWindow: r.value.contextWindow, maxTokens: r.value.maxTokens };
      }
    }
  }
  return specs;
}

// Extract first API key from KeyMux env (for native API calls)
function getFirstApiKey(provName) {
  const envVars = {
    gemini: "GEMINI_KEYS",
    groq: "GROQ_KEYS",
  };
  const varName = envVars[provName];
  if (!varName) return null;
  const keys = (process.env[varName] || "").split(",").map(k => k.trim()).filter(Boolean);
  return keys[0] || null;
}

async function main() {
  // 1. Fetch aggregated models from KeyMux
  const headers = {};
  if (KEYMUX_PROXY_KEY) headers.authorization = `Bearer ${KEYMUX_PROXY_KEY}`;

  console.log(`[sync] Fetching models from ${KEYMUX_URL}/models ...`);
  const { data: models } = await httpGet(`${KEYMUX_URL}/models`, headers);
  console.log(`[sync] Got ${models.length} models`);

  // 2. Fetch providers list
  const { providers: providerList } = await httpGet(`${KEYMUX_URL}/providers`, headers);
  console.log(`[sync] Providers: ${Object.keys(providerList).join(", ")}`);

  // 3. Group models by provider
  const byProvider = {};
  for (const m of models) {
    const prov = m.provider || "unknown";
    if (!byProvider[prov]) byProvider[prov] = [];
    byProvider[prov].push(m);
  }

  // 4. Read existing models.json
  let existing = { providers: {} };
  try {
    existing = JSON.parse(fs.readFileSync(MODELS_JSON, "utf8"));
  } catch (err) {
    console.log(`[sync] No existing ${MODELS_JSON}, creating fresh`);
  }

  // 5. Remove old keymux-* providers
  for (const key of Object.keys(existing.providers)) {
    if (key.startsWith("keymux-")) delete existing.providers[key];
  }

  // 6. Add KeyMux providers with discovered models
  for (const [provName, provConfig] of Object.entries(providerList)) {
    const provModels = byProvider[provName] || [];
    if (provModels.length === 0) continue;

    // Filter to chat-capable models (skip embedding, imagen, veo, audio, deprecated, etc.)
    const chatModels = provModels.filter((m) => {
      const id = m.id || "";
      if (/embed|imagen|veo|lyria|aqa|tts|audio|live|robotics|nano-banana|generate|clip|gemma|guard|whisper|distil|tool-use|prompt-guard/.test(id)) return false;
      if (/^models\/gemini-2\.0-flash-(001|lite-001|lite)$/.test(m.id || "")) return false;
      if (/gemini-2\.0-flash-001|gemini-2\.0-flash-lite-001|gemini-2\.0-flash-lite$/.test(id)) return false;
      if (/deep-research/.test(id)) return false;
      if (/computer-use/.test(id)) return false;
      return true;
    });

    if (chatModels.length === 0) continue;

    // Fetch native model specs for providers that don't return context_window in /models
    const cleanIds = chatModels.map(m => (m.id || "").replace(/^models\//, ""));
    const needsNativeApi = chatModels.some(m => !m.context_window);
    let nativeSpecs = {};
    if (needsNativeApi && NATIVE_MODEL_APIS[provName]) {
      const apiKey = getFirstApiKey(provName);
      if (apiKey) {
        console.log(`[sync] Fetching native model specs for ${provName} (${cleanIds.length} models)...`);
        nativeSpecs = await fetchNativeModelSpecs(provName, cleanIds, apiKey);
        console.log(`[sync]   Got specs for ${Object.keys(nativeSpecs).length} models`);
      }
    }

    existing.providers[`keymux-${provName}`] = {
      baseUrl: `${KEYMUX_URL}/${provName}/v1`,
      api: "openai-completions",
      apiKey: "KEYMUX_PROXY_KEY",
      // Compat: Gemini/Groq OpenAI-compat endpoints reject unknown fields
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
      models: chatModels.map((m) => {
        const cleanId = (m.id || "").replace(/^models\//, "");
        const isReasoning = false;
        const supportsImage = /gemini|flash|pro|vision|grok-4-fast|llama-4|scout/.test(cleanId);

        // Resolution order for context window and max tokens:
        // 1. Native API (most accurate — e.g. Gemini's inputTokenLimit)
        // 2. OpenAI-compat /models response (e.g. Groq returns context_window)
        // 3. Static fallback table (last resort)
        const native = nativeSpecs[cleanId] || {};
        const fallback = MODEL_SPECS_FALLBACK[cleanId] || {};
        const contextWindow = native.contextWindow || m.context_window || fallback.contextWindow || 131072;
        const maxTokens = native.maxTokens || m.max_completion_tokens || fallback.maxTokens || 8192;

        return {
          id: cleanId,
          name: `${cleanId} (${provName})`,
          reasoning: isReasoning,
          input: supportsImage ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens,
        };
      }),
    };

    console.log(`[sync] keymux-${provName}: ${chatModels.length} chat models`);
  }

  // 7. Build provider entry for openclaw.json (structured apiKey format)
  const ocProviders = {};
  for (const [provName] of Object.entries(providerList)) {
    const key = `keymux-${provName}`;
    if (!existing.providers[key]) continue;
    // openclaw.json schema does NOT allow "compat" — strip it
    const { compat, ...rest } = existing.providers[key];
    ocProviders[key] = {
      ...rest,
      apiKey: { source: "env", provider: "default", id: "KEYMUX_PROXY_KEY" },
    };
  }

  // 8. Write updated models.json (atomic)
  const tmp = MODELS_JSON + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, MODELS_JSON);
  console.log(`[sync] Updated ${MODELS_JSON}`);
  console.log(`[sync] Total providers: ${Object.keys(existing.providers).join(", ")}`);

  // 9. Update openclaw.json — providers + model allowlist
  try {
    const oc = JSON.parse(fs.readFileSync(OPENCLAW_JSON, "utf8"));

    // 9a. Update models.providers (for config-based provider resolution)
    if (oc.models && oc.models.providers) {
      for (const key of Object.keys(oc.models.providers)) {
        if (key.startsWith("keymux-")) delete oc.models.providers[key];
      }
      Object.assign(oc.models.providers, ocProviders);
    }

    // 9b. Update agents.defaults.models allowlist (required for /models visibility)
    if (!oc.agents) oc.agents = {};
    if (!oc.agents.defaults) oc.agents.defaults = {};
    if (!oc.agents.defaults.models) oc.agents.defaults.models = {};
    const allowlist = oc.agents.defaults.models;

    // Remove old keymux-* allowlist entries
    for (const key of Object.keys(allowlist)) {
      if (key.startsWith("keymux-")) delete allowlist[key];
    }

    // Add all discovered keymux models to allowlist
    let allowlistCount = 0;
    for (const [provName] of Object.entries(providerList)) {
      const key = `keymux-${provName}`;
      const prov = existing.providers[key];
      if (!prov || !prov.models) continue;
      for (const model of prov.models) {
        allowlist[`${key}/${model.id}`] = {};
        allowlistCount++;
      }
    }

    const ocTmp = OPENCLAW_JSON + ".tmp";
    fs.writeFileSync(ocTmp, JSON.stringify(oc, null, 2));
    fs.renameSync(ocTmp, OPENCLAW_JSON);
    console.log(`[sync] Updated ${OPENCLAW_JSON} (${Object.keys(ocProviders).length} providers, ${allowlistCount} models in allowlist)`);
  } catch (err) {
    console.log(`[sync] Skipping openclaw.json update: ${err.message}`);
  }
}

main().catch((err) => {
  console.error(`[sync] ERROR: ${err.message}`);
  process.exit(1);
});
