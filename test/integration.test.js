/**
 * Integration tests — real provider round-trips.
 *
 * These tests call actual LLM APIs and are skipped when environment
 * variables are not set. Run with:
 *
 *   GEMINI_KEYS=key1 GROQ_KEYS=gsk_key1 node --test engine/test/integration.test.js
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const http = require("node:http");
const Pool = require("../lib/pool");
const path = require("node:path");
const os = require("node:os");

function tmpStatsFile() {
  return path.join(os.tmpdir(), `ffai-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const GEMINI_KEYS = (process.env.GEMINI_KEYS || "").split(",").filter(Boolean);
const GROQ_KEYS = (process.env.GROQ_KEYS || "").split(",").filter(Boolean);

function callAPI(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(raw); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe("Integration: Gemini", { skip: GEMINI_KEYS.length === 0 ? "no GEMINI_KEYS set" : false }, () => {
  let pool;

  it("acquires key, calls chat completions, releases with outcome", async () => {
    pool = new Pool({
      providers: {
        gemini: {
          keys: GEMINI_KEYS,
          rpm_limit: 15,
          tpm_limit: 1000000,
          rpd_limit: 1500,
          auth_scheme: "header",
          auth_header: "x-goog-api-key",
        },
      },
      statsFile: tmpStatsFile(),
      statsFlushInterval: 0,
      logger: { log() {}, warn() {}, error() {} },
    });

    const handle = pool.acquire("gemini");
    assert.ok(handle, "should acquire a key");
    assert.equal(handle.provider, "gemini");

    const startTime = Date.now();
    const res = await callAPI(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      { "x-goog-api-key": handle.key },
      {
        model: "gemini-2.0-flash",
        messages: [{ role: "user", content: "Say 'hello' and nothing else." }],
        max_tokens: 10,
      }
    );

    const latencyMs = Date.now() - startTime;

    if (res.status === 200) {
      assert.ok(res.json, "response should be valid JSON");
      assert.ok(res.json.choices, "response should have choices");
      pool.release("gemini", handle.key, {
        success: true,
        statusCode: 200,
        inputTokens: 10,
        outputTokens: res.json.usage?.completion_tokens || 0,
        latencyMs,
      });
    } else if (res.status === 429) {
      // Rate limited — still valid, release as rate limit
      pool.release("gemini", handle.key, {
        success: false,
        statusCode: 429,
        retryAfter: res.headers["retry-after"],
        latencyMs,
      });
    } else {
      pool.release("gemini", handle.key, {
        success: false,
        statusCode: res.status,
        latencyMs,
      });
      // Don't fail — the key might be invalid
      console.log(`[integration] Gemini returned ${res.status}: ${res.body.slice(0, 200)}`);
    }

    // Verify pool health is still functional
    const health = pool.health();
    assert.ok(["ok", "degraded"].includes(health.status));
    pool.shutdown();
  });
});

describe("Integration: Groq", { skip: GROQ_KEYS.length === 0 ? "no GROQ_KEYS set" : false }, () => {
  let pool;

  it("acquires key, calls chat completions, releases with outcome", async () => {
    pool = new Pool({
      providers: {
        groq: {
          keys: GROQ_KEYS,
          rpm_limit: 30,
          rpd_limit: 14400,
          auth_scheme: "bearer",
        },
      },
      statsFile: tmpStatsFile(),
      statsFlushInterval: 0,
      logger: { log() {}, warn() {}, error() {} },
    });

    const handle = pool.acquire("groq");
    assert.ok(handle, "should acquire a key");
    assert.equal(handle.provider, "groq");

    const startTime = Date.now();
    const res = await callAPI(
      "https://api.groq.com/openai/v1/chat/completions",
      { authorization: `Bearer ${handle.key}` },
      {
        model: "llama-3.1-8b-instant",
        messages: [{ role: "user", content: "Say 'hello' and nothing else." }],
        max_tokens: 10,
      }
    );

    const latencyMs = Date.now() - startTime;

    if (res.status === 200) {
      assert.ok(res.json, "response should be valid JSON");
      assert.ok(res.json.choices, "response should have choices");
      pool.release("groq", handle.key, {
        success: true,
        statusCode: 200,
        inputTokens: 10,
        outputTokens: res.json.usage?.completion_tokens || 0,
        latencyMs,
      });
    } else if (res.status === 429) {
      pool.release("groq", handle.key, {
        success: false,
        statusCode: 429,
        retryAfter: res.headers["retry-after"],
        latencyMs,
      });
    } else {
      pool.release("groq", handle.key, {
        success: false,
        statusCode: res.status,
        latencyMs,
      });
      console.log(`[integration] Groq returned ${res.status}: ${res.body.slice(0, 200)}`);
    }

    const health = pool.health();
    assert.ok(["ok", "degraded"].includes(health.status));
    pool.shutdown();
  });
});

describe("Integration: Pool key rotation with real keys", { skip: GEMINI_KEYS.length < 2 ? "need 2+ GEMINI_KEYS" : false }, () => {
  it("rotates across multiple keys", async () => {
    const pool = new Pool({
      providers: {
        gemini: {
          keys: GEMINI_KEYS,
          rpm_limit: 15,
          auth_scheme: "header",
          auth_header: "x-goog-api-key",
        },
      },
      statsFile: tmpStatsFile(),
      statsFlushInterval: 0,
      logger: { log() {}, warn() {}, error() {} },
    });

    const usedKeys = new Set();
    for (let i = 0; i < Math.min(GEMINI_KEYS.length * 2, 6); i++) {
      const handle = pool.acquire("gemini");
      assert.ok(handle, `acquire attempt ${i} should succeed`);
      usedKeys.add(handle.key);
      pool.release("gemini", handle.key, { success: true });
    }
    assert.ok(usedKeys.size >= 2, `should use at least 2 keys, used ${usedKeys.size}`);
    pool.shutdown();
  });
});
