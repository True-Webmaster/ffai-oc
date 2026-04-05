#!/usr/bin/env node
// sync-models.js — Fetches models from KeyMux /models and updates OpenClaw models.json
// Usage: node sync-models.js [path-to-models.json]
//
// Reads KEYMUX_URL and KEYMUX_PROXY_KEY from env (or defaults to localhost:8002).
// Merges discovered models into the existing models.json, preserving non-KeyMux providers.

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const KEYMUX_URL = (process.env.KEYMUX_URL || "http://127.0.0.1:8002").replace(/\/+$/, "");
const KEYMUX_PROXY_KEY = process.env.KEYMUX_PROXY_KEY || "";
const MODELS_JSON = process.argv[2] || path.join(process.env.HOME, ".openclaw", "agents", "main", "agent", "models.json");
const OPENCLAW_JSON = process.env.OPENCLAW_JSON || path.join(process.env.HOME, ".openclaw", "openclaw.json");

// Known model specs — the OpenAI-compat /models endpoint often omits context_window
// and max_completion_tokens, so we maintain accurate values here.
// These override API-reported values (which default to 131072/8192).
const MODEL_SPECS = {
  // Gemini
  "gemini-2.5-flash":           { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.5-pro":             { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.0-flash":           { contextWindow: 1048576, maxTokens: 8192 },
  "gemini-flash-latest":        { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-flash-lite-latest":   { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-pro-latest":          { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.5-flash-lite":      { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-2.5-flash-image":     { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3-pro-preview":       { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3-flash-preview":     { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.1-pro-preview":     { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3.1-flash-lite-preview": { contextWindow: 1048576, maxTokens: 65536 },
  // Groq
  "llama-3.3-70b-versatile":    { contextWindow: 131072, maxTokens: 32768 },
  "llama-3.1-8b-instant":       { contextWindow: 131072, maxTokens: 8192 },
  "meta-llama/llama-4-scout-17b-16e-instruct": { contextWindow: 131072, maxTokens: 8192 },
  "qwen/qwen3-32b":             { contextWindow: 131072, maxTokens: 32768 },
  "moonshotai/kimi-k2-instruct": { contextWindow: 131072, maxTokens: 16384 },
  "deepseek-r1-distill-llama-70b": { contextWindow: 131072, maxTokens: 16384 },
};

function fetch(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
  });
}

async function main() {
  // 1. Fetch aggregated models from KeyMux
  const headers = {};
  if (KEYMUX_PROXY_KEY) headers.authorization = `Bearer ${KEYMUX_PROXY_KEY}`;

  console.log(`[sync] Fetching models from ${KEYMUX_URL}/models ...`);
  const { data: models } = await fetch(`${KEYMUX_URL}/models`, headers);
  console.log(`[sync] Got ${models.length} models`);

  // 2. Fetch providers list
  const { providers: providerList } = await fetch(`${KEYMUX_URL}/providers`, headers);
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
      // Non-chat model types
      if (/embed|imagen|veo|lyria|aqa|tts|audio|live|robotics|nano-banana|generate|clip|gemma|guard|whisper|distil|tool-use/.test(id)) return false;
      // Deprecated/dead Gemini versions
      if (/^models\/gemini-2\.0-flash-(001|lite-001|lite)$/.test(m.id || "")) return false;
      if (/gemini-2\.0-flash-001|gemini-2\.0-flash-lite-001|gemini-2\.0-flash-lite$/.test(id)) return false;
      // Deep research uses Interactions API, not chat completions
      if (/deep-research/.test(id)) return false;
      // Computer-use models need special API
      if (/computer-use/.test(id)) return false;
      return true;
    });

    if (chatModels.length === 0) continue;

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
        // Gemini's OpenAI-compat endpoint does NOT support the "thinking" parameter —
        // it returns 400 "Unknown name thinking". Gemini handles thinking internally.
        // Groq also doesn't support it. So always false for keymux models.
        const isReasoning = false;
        const supportsImage = /gemini|flash|pro|vision|grok-4-fast|llama-4|scout/.test(cleanId);
        const specs = MODEL_SPECS[cleanId] || {};
        return {
          id: cleanId,
          name: `${cleanId} (${provName})`,
          reasoning: isReasoning,
          input: supportsImage ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: specs.contextWindow || m.context_window || 131072,
          maxTokens: specs.maxTokens || m.max_completion_tokens || 8192,
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
