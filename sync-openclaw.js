#!/usr/bin/env node
// sync-openclaw.js — Syncs FFAI's discovered models into OpenClaw's openclaw.json
//
// Usage:
//   node sync-openclaw.js                    # One-shot sync
//   node sync-openclaw.js --watch            # Sync every 5 minutes (matches FFAI discovery interval)
//   node sync-openclaw.js --all-agents       # Also update per-agent models.json files
//
// Reads FFAI_URL, FFAI_KEY from env (defaults to localhost:8010).
// Fetches /models and /providers from FFAI, builds OpenClaw provider entries,
// and atomically updates openclaw.json (providers + model allowlist).
//
// NOTE: When FFAI_OPENCLAW_SYNC=true in .env, serve.js handles this automatically.
//       This CLI is for manual one-shot syncs or when running FFAI standalone.
//
// Zero dependencies — uses Node built-in http/https.

const http = require("http");
const https = require("https");
const path = require("path");
const { writeOpenclawJson, writeAgentModels, PROVIDER_PREFIX } = require("./lib/openclaw-sync");
const fs = require("fs");

const FFAI_URL = (process.env.FFAI_URL || "http://127.0.0.1:8010").replace(/\/+$/, "");
const FFAI_KEY = process.env.FFAI_KEY || "";
const HOME = process.env.HOME || require("os").homedir();
const OPENCLAW_JSON = process.env.OPENCLAW_JSON || path.join(HOME, ".openclaw", "openclaw.json");

const ALL_AGENTS = process.argv.includes("--all-agents");
const WATCH = process.argv.includes("--watch");
const WATCH_INTERVAL = parseInt(process.env.SYNC_INTERVAL || "300000", 10); // 5min

const HTTP_MAX_BODY = 10 * 1024 * 1024;
const HTTP_WALL_TIMEOUT = 30000;

// ── HTTP helper ──────────────────────────────────────────────────────────────
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
        } catch (parseErr) {
          done(reject, new Error(`Invalid JSON: ${parseErr.message}`));
        }
      });
    });
    req.on("error", (e) => { clearTimeout(wallTimer); done(reject, e); });
    req.on("timeout", () => { clearTimeout(wallTimer); req.destroy(new Error("socket timeout")); });
  });
}

// ── Discover models from FFAI ────────────────────────────────────────────────
async function discover() {
  const headers = {};
  if (FFAI_KEY) headers.authorization = `Bearer ${FFAI_KEY}`;

  // Fetch models (with retry)
  let modelsResp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      modelsResp = await httpGet(`${FFAI_URL}/models`, headers);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`[sync] /models attempt ${attempt + 1} failed: ${err.message}, retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const models = modelsResp?.data;
  if (!Array.isArray(models)) throw new Error(`/models response missing "data" array`);

  // Fetch providers
  let providersResp;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      providersResp = await httpGet(`${FFAI_URL}/providers`, headers);
      break;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const providerList = providersResp?.providers;
  if (!providerList || typeof providerList !== "object") throw new Error(`/providers missing "providers" object`);

  // Group models by provider (separate favorites)
  const byProvider = {};
  const favoritesModels = [];
  for (const m of models) {
    const prov = m.provider || m.owned_by || "unknown";
    if (prov === "favorites") {
      favoritesModels.push(m);
      continue;
    }
    if (m.id === prov && !m.context_window) continue;
    if (!byProvider[prov]) byProvider[prov] = [];
    byProvider[prov].push(m);
  }

  // Build OpenClaw provider entries
  const ocProviders = {};
  for (const provName of Object.keys(providerList)) {
    const provModels = byProvider[provName] || [];
    if (provModels.length === 0) continue;

    const ocKey = `${PROVIDER_PREFIX}${provName}`;
    const modelEntries = provModels.map((m) => {
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
      baseUrl: `${FFAI_URL}/${provName}/v1`,
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "FFAI_KEY" },
      models: modelEntries,
    };
  }

  // Build favorites virtual provider
  if (favoritesModels.length > 0) {
    const favEntries = favoritesModels.map((m) => {
      const cleanId = (m.id || "").replace(/^models\//, "");
      const srcProv = m._source_provider || "unknown";
      const supportsImage = Array.isArray(m.input_types) && m.input_types.includes("image");
      const contextWindow = m.context_window || 131072;
      const maxTokens = m.max_output_tokens || 8192;

      return {
        id: cleanId,
        name: `${cleanId} (${srcProv})`,
        reasoning: false,
        input: supportsImage ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens,
      };
    });

    ocProviders["ffai-favorites"] = {
      baseUrl: `${FFAI_URL}/v1`,
      api: "openai-completions",
      apiKey: { source: "env", provider: "default", id: "FFAI_KEY" },
      models: favEntries,
    };
    console.log(`[sync] Favorites: ${favEntries.length} models`);
  }

  const totalModels = Object.values(ocProviders).reduce((s, p) => s + p.models.length, 0);
  console.log(`[sync] Discovered ${totalModels} models across ${Object.keys(ocProviders).length} providers: ${Object.keys(ocProviders).join(", ")}`);

  return ocProviders;
}

// ── Main sync ────────────────────────────────────────────────────────────────
async function sync() {
  const startMs = Date.now();
  try {
    const ocProviders = await discover();

    // Wipe protection
    const totalModels = Object.values(ocProviders).reduce((s, p) => s + p.models.length, 0);
    if (totalModels === 0) {
      console.error("[sync] ABORT: Discovery returned 0 models — refusing to wipe config");
      return false;
    }

    if (!writeOpenclawJson(OPENCLAW_JSON, ocProviders, console)) return false;

    if (ALL_AGENTS) {
      const agentsDir = path.join(HOME, ".openclaw", "agents");
      writeAgentModels(agentsDir, ocProviders, FFAI_URL, console);
    }

    console.log(`[sync] Done in ${Date.now() - startMs}ms`);
    return true;
  } catch (err) {
    console.error(`[sync] ERROR: ${err.message}`);
    return false;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  await sync();

  if (WATCH) {
    console.log(`[sync] Watching — will re-sync every ${WATCH_INTERVAL / 1000}s`);
    const timer = setInterval(sync, WATCH_INTERVAL);
    if (timer.unref) timer.unref();

    process.on("SIGHUP", () => {
      console.log("[sync] SIGHUP received — re-syncing...");
      sync();
    });
  }
}

main().catch((err) => {
  console.error(`[sync] FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
