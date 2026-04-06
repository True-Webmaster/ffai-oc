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

// Security: Enforce HTTPS for non-loopback KEYMUX_URL
(function enforceHttps() {
  try {
    const u = new (require("url").URL)(KEYMUX_URL);
    const isLoopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname);
    if (!isLoopback && u.protocol !== "https:") {
      console.error(`[sync] FATAL: Remote KEYMUX_URL must use HTTPS (got ${u.protocol}//${u.hostname})`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[sync] FATAL: Invalid KEYMUX_URL: ${KEYMUX_URL}`);
    process.exit(1);
  }
})();
const KEYMUX_PROXY_KEY = process.env.KEYMUX_PROXY_KEY || "";
const HOME = process.env.HOME || require("os").homedir();
const MODELS_JSON = process.argv[2] || path.join(HOME, ".openclaw", "agents", "main", "agent", "models.json");
const OPENCLAW_JSON = process.env.OPENCLAW_JSON || path.join(HOME, ".openclaw", "openclaw.json");

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
    authScheme: "header", // x-goog-api-key header (not query param — avoids key in URL/logs)
    parse: (data) => ({
      contextWindow: data.inputTokenLimit || 0,
      maxTokens: data.outputTokenLimit || 0,
    }),
  },
};

const HTTP_MAX_BODY = 10 * 1024 * 1024; // 10MB response body limit
const HTTP_WALL_TIMEOUT = 30000; // 30s hard wall-clock deadline

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const mod = url.startsWith("https://") ? https : http;
    const wallTimer = setTimeout(() => {
      req.destroy();
      done(reject, new Error("wall-clock timeout"));
    }, HTTP_WALL_TIMEOUT);
    const req = mod.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks = [];
      let totalBytes = 0;
      res.on("data", (c) => {
        totalBytes += c.length;
        if (totalBytes > HTTP_MAX_BODY) {
          clearTimeout(wallTimer);
          req.destroy();
          return done(reject, new Error("response too large"));
        }
        chunks.push(c);
      });
      res.on("error", (e) => { clearTimeout(wallTimer); done(reject, e); });
      res.on("end", () => {
        clearTimeout(wallTimer);
        if (res.statusCode !== 200) return done(reject, new Error(`HTTP ${res.statusCode}`));
        try {
          done(resolve, JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          done(reject, new Error(`Invalid JSON from ${url.split("?")[0]}`));
        }
      });
    });
    req.on("error", (e) => { clearTimeout(wallTimer); done(reject, e); });
    req.on("timeout", () => { req.destroy(new Error("socket timeout")); });
  });
}

// Fetch model specs from a provider's native API (e.g. Gemini's /v1beta/models)
const NATIVE_SPEC_TIMEOUT = 30000; // 30s aggregate timeout for all native spec fetches

async function fetchNativeModelSpecs(provName, modelIds, apiKey) {
  const api = NATIVE_MODEL_APIS[provName];
  if (!api || !apiKey) return {};

  const specs = {};
  const deadline = Date.now() + NATIVE_SPEC_TIMEOUT;
  const batchSize = 5; // parallel requests, be gentle
  for (let i = 0; i < modelIds.length; i += batchSize) {
    if (Date.now() > deadline) {
      console.warn(`[sync] Native spec fetch timeout — got ${Object.keys(specs).length}/${modelIds.length} models`);
      break;
    }
    const batch = modelIds.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (id) => {
      let url = api.urlTemplate(id);
      const headers = {};
      if (api.authScheme === "header") headers["x-goog-api-key"] = apiKey;
      else if (api.authScheme === "bearer") headers.authorization = `Bearer ${apiKey}`;
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
  let modelsResp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      modelsResp = await httpGet(`${KEYMUX_URL}/models`, headers);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[sync] /models attempt ${attempt + 1} failed: ${err.message}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const models = modelsResp?.data;
  if (!Array.isArray(models)) throw new Error(`/models response missing "data" array`);
  console.log(`[sync] Got ${models.length} models`);

  // 2. Fetch providers list (with retries, same as /models)
  let providersResp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      providersResp = await httpGet(`${KEYMUX_URL}/providers`, headers);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[sync] /providers attempt ${attempt + 1} failed: ${err.message}, retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const providerList = providersResp?.providers;
  if (!providerList || typeof providerList !== "object") throw new Error(`/providers response missing "providers" object`);
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
    if (err.code === "ENOENT") {
      console.log(`[sync] No existing ${MODELS_JSON}, creating fresh`);
    } else {
      console.error(`[sync] WARNING: Corrupt ${MODELS_JSON}: ${err.message} — backing up and creating fresh`);
      try { fs.copyFileSync(MODELS_JSON, MODELS_JSON + ".corrupt"); } catch {}
    }
  }
  if (!existing.providers) existing.providers = {};

  // 5. Remove old keymux-* providers
  for (const key of Object.keys(existing.providers)) {
    if (key.startsWith("keymux-")) delete existing.providers[key];
  }

  // 6. Add KeyMux providers with discovered models
  for (const [provName, provConfig] of Object.entries(providerList)) {
    const provModels = byProvider[provName] || [];
    if (provModels.length === 0) continue;

    // ── Programmatic model filtering (no hardcoded model names) ──────────────
    // All rules are pattern-based so new models are auto-included or excluded.
    const MIN_CONTEXT_WINDOW = 8192;  // Min ctx for multi-turn conversations
    const MIN_OUTPUT_TOKENS = 4096;   // Min output for useful responses
    const MIN_PARAM_BILLIONS = 4;     // Skip tiny models (1b, 2b, 3b)

    // Collect all IDs for dedup detection
    const allIds = new Set(provModels.map(m => (m.id || "").replace(/^models\//, "")));

    const chatModels = provModels.filter((m) => {
      const id = (m.id || "").replace(/^models\//, "");
      const idLower = id.toLowerCase();

      // 1. Skip non-chat model categories (by keyword in ID)
      const NON_CHAT_KEYWORDS = /embed|imagen|veo|lyria|aqa|tts|audio|live|robotics|generate|clip|guard|whisper|distil|orpheus|safeguard/;
      if (NON_CHAT_KEYWORDS.test(idLower)) return false;

      // 2. Skip image-generation models (contain "image" in the name)
      if (/\bimage\b/.test(idLower)) return false;

      // 3. Skip special-purpose models
      if (/deep-research|computer-use|customtools/.test(idLower)) return false;

      // 4. Skip "-latest" aliases (they point to a versioned model we already include)
      if (/-latest$/.test(idLower)) {
        console.log(`[sync] Skipping alias ${id}`);
        return false;
      }

      // 5. Skip versioned duplicates: if "model-001" exists and "model" also exists, skip "-001"
      const deVersioned = id.replace(/-\d{3}$/, "");
      if (deVersioned !== id && allIds.has(deVersioned)) {
        console.log(`[sync] Skipping versioned duplicate ${id} (have ${deVersioned})`);
        return false;
      }

      // 6. Skip tiny models by parameter count in the name
      //    Matches: "-4b-", "-31b-it", "e2b-it" (effective params), "-1b-"
      const paramMatch = idLower.match(/(?:^|[/-])(\d+(?:\.\d+)?)b(?:[^a-z]|$)/) ||
                         idLower.match(/[/-]e(\d+(?:\.\d+)?)b(?:[^a-z]|$)/);
      if (paramMatch) {
        const params = parseFloat(paramMatch[1]);
        if (params < MIN_PARAM_BILLIONS) {
          console.log(`[sync] Skipping ${id}: ${params}B params < ${MIN_PARAM_BILLIONS}B minimum`);
          return false;
        }
      }

      // 7. Filter by context window (pre-check — applied again after native spec resolution)
      const ctx = m.context_window || 0;
      if (ctx > 0 && ctx < MIN_CONTEXT_WINDOW) {
        console.log(`[sync] Skipping ${id}: context_window ${ctx} < ${MIN_CONTEXT_WINDOW}`);
        return false;
      }

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
        const supportsImage = /\bgemini\b|\bflash\b|\bvision\b|\bgrok-4-fast\b|\bllama-4\b|\bscout\b|\bgemma-[34]/.test(cleanId);

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

    // Post-filter: remove models with resolved specs below minimums
    const beforeCount = existing.providers[`keymux-${provName}`].models.length;
    existing.providers[`keymux-${provName}`].models = existing.providers[`keymux-${provName}`].models.filter((m) => {
      if (m.contextWindow < MIN_CONTEXT_WINDOW) {
        console.log(`[sync] Dropping ${m.id}: contextWindow ${m.contextWindow} < ${MIN_CONTEXT_WINDOW}`);
        return false;
      }
      if (m.maxTokens < MIN_OUTPUT_TOKENS) {
        console.log(`[sync] Dropping ${m.id}: maxTokens ${m.maxTokens} < ${MIN_OUTPUT_TOKENS}`);
        return false;
      }
      return true;
    });
    const afterCount = existing.providers[`keymux-${provName}`].models.length;
    if (afterCount < beforeCount) {
      console.log(`[sync] keymux-${provName}: dropped ${beforeCount - afterCount} models below minimums`);
    }

    console.log(`[sync] keymux-${provName}: ${afterCount} chat models`);
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
  fs.mkdirSync(path.dirname(MODELS_JSON), { recursive: true });
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
  console.error(`[sync] ERROR: ${err.stack || err.message}`);
  process.exit(1);
});
