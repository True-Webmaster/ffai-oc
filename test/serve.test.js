const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// ── Test constants ──────────────────────────────────────────────────────────
const FFAI_KEY = "test-secret-key-abc123";
// ADMIN_KEY is set to the same as FFAI_KEY so /stats works with a single
// Authorization header (the general auth gate at line 289 checks FFAI_KEY first,
// then /stats checks ADMIN_KEY — both must pass with the same bearer token).
const ADMIN_KEY = "test-secret-key-abc123";
const NODE_BIN = process.execPath;
const SERVE_JS = path.join(__dirname, "..", "serve.js");

// ── Temp config / stats setup ───────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffai-serve-test-"));
const configFile = path.join(tmpDir, "config.json");
const statsFile = path.join(tmpDir, "stats.json");

const testConfig = {
  providers: {
    fakeprov: {
      keys: ["fake-key-aaa-111", "fake-key-bbb-222"],
      upstream_url: "https://localhost:19999", // nothing listens here
      auth_scheme: "bearer",
      rpm_limit: 10,
      tpm_limit: 100000,
      rpd_limit: 1000,
      default_cooldown: 5,
      max_cooldown: 10,
      retryable_statuses: [429, 502, 503],
      key_cb_threshold: 5,
      key_cb_cooldown: 60000,
      family: "testfam",
    },
  },
};

fs.writeFileSync(configFile, JSON.stringify(testConfig, null, 2));

// ── Dynamic port / BASE ────────────────────────────────────────────────────
let PORT;
let BASE;

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Simple HTTP request returning { status, headers, body } */
function request(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: opts.method || "GET",
      headers: opts.headers || {},
      timeout: 5000,
    };
    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = JSON.parse(body); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("request timeout")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function authHeader(key) {
  return { authorization: `Bearer ${key}` };
}

// ── Spawn / teardown ────────────────────────────────────────────────────────
let child;

/** Wait until the server is accepting connections (up to `ms` ms). */
function waitForServer(base, ms = 5000) {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function attempt() {
      if (Date.now() > deadline) return reject(new Error("server did not start in time"));
      const url = new URL("/health", base);
      const probe = http.get({
        hostname: url.hostname,
        port: url.port,
        path: "/health",
        headers: { authorization: `Bearer ${FFAI_KEY}` },
      }, (res) => {
        res.resume();
        resolve();
      });
      probe.on("error", () => setTimeout(attempt, 80));
      probe.end();
    })();
  });
}

describe("serve.js HTTP bridge", { concurrency: 1 }, () => {
  before(async () => {
    child = spawn(NODE_BIN, [SERVE_JS], {
      env: {
        ...process.env,
        FFAI_PORT: "0", // let the OS pick a free port
        FFAI_BIND: "127.0.0.1",
        FFAI_KEY: FFAI_KEY,
        FFAI_ADMIN_KEY: ADMIN_KEY,
        FFAI_CONFIG: configFile,
        FFAI_STATS_FILE: statsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Parse actual port from server stdout line:
    //   [ffai] Bridge listening on 127.0.0.1:PORT
    const portPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not print listening line in time")), 10000);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const match = buf.match(/Bridge listening on [^:]+:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve.js exited with code ${code} before printing port`));
      });
    });

    // Capture stderr for debugging failures
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("exit", (code) => {
      if (code && code !== 0 && code !== null) {
        console.error(`[test] serve.js exited with code ${code}\n${stderr}`);
      }
    });

    PORT = await portPromise;
    BASE = `http://127.0.0.1:${PORT}`;

    await waitForServer(BASE);
  });

  after(() => {
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    // Clean up temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── /health ─────────────────────────────────────────────────────────────
  describe("GET /health", () => {
    it("returns 200 with bare status only when unauthenticated", async () => {
      // Single unauthenticated request — each one counts as an auth failure
      // in the auth guard, so avoid redundant unauthenticated calls.
      const res = await request("/health");
      assert.equal(res.status, 200);
      assert.ok(res.json, "response should be valid JSON");
      assert.ok(["ok", "degraded"].includes(res.json.status), `unexpected status: ${res.json.status}`);
      assert.equal(res.json.providers, undefined, "should not leak providers without auth");
    });

    it("returns providers info when authenticated", async () => {
      const res = await request("/health", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json.providers, "should contain providers");
      assert.ok(res.json.providers.fakeprov, "should contain fakeprov");
    });
  });

  // ── /health?detailed ───────────────────────────────────────────────────
  describe("GET /health?detailed", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/health?detailed");
      assert.equal(res.status, 401);
    });

    it("returns per-key info when authenticated", async () => {
      const res = await request("/health?detailed", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json, "response should be valid JSON");
      assert.ok(res.json.providers, "should contain providers");
      assert.ok(res.json.providers.fakeprov, "should contain fakeprov detail");
      // Detailed response should include key-level information
      const fp = res.json.providers.fakeprov;
      assert.ok(fp.keys || fp.key_status || fp.details,
        "detailed health should include key-level info");
    });
  });

  // ── /models ─────────────────────────────────────────────────────────────
  describe("GET /models", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/models");
      assert.equal(res.status, 401);
    });

    it("returns 200 with provider list when authenticated", async () => {
      const res = await request("/models", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json, "response should be valid JSON");
      assert.equal(res.json.object, "list");
      assert.ok(Array.isArray(res.json.data), "data should be an array");
      const names = res.json.data.map((m) => m.id);
      assert.ok(names.includes("fakeprov"), "should list fakeprov");
    });
  });

  // ── /{provider}/models (filtered per-provider slice) ─────────────────────
  // Mirrors /models's curated/filtered list but scoped to a single provider.
  // Designed for clients that point at `<bridge>/<provider>` and rely on
  // `<base_url>/models` for discovery — without this route they'd hit
  // /<provider>/v1/models (raw upstream passthrough) and see unfiltered
  // pay-only/free-tier-zero models.
  describe("GET /{provider}/models", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/fakeprov/models");
      assert.equal(res.status, 401);
    });

    it("returns 200 with only entries for the named provider", async () => {
      const res = await request("/fakeprov/models", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.equal(res.json.object, "list");
      assert.ok(Array.isArray(res.json.data));
      // Every entry must belong to fakeprov (or no entries at all if the
      // curated list happens to be empty — but never a different provider).
      for (const m of res.json.data) {
        assert.equal(m.provider, "fakeprov", `entry leaked from another provider: ${JSON.stringify(m)}`);
      }
      // _source_provider is an internal favorites field; never surfaced
      // on the per-provider slice.
      for (const m of res.json.data) {
        assert.equal(m._source_provider, undefined, "_source_provider must be stripped");
      }
    });

    it("returns 404 for an unknown provider", async () => {
      const res = await request("/no-such-provider/models", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 404);
      assert.match(res.json.error || "", /unknown provider/);
    });

    it("excludes favorites virtual entries from the slice", async () => {
      // The favorites virtual provider has provider="favorites"; a per-
      // provider slice for "fakeprov" must never include it.
      const res = await request("/fakeprov/models", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      const favs = res.json.data.filter((m) => m.provider === "favorites");
      assert.equal(favs.length, 0, "favorites entries leaked into per-provider slice");
    });
  });

  // ── /stats ──────────────────────────────────────────────────────────────
  describe("GET /stats", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/stats");
      assert.equal(res.status, 401);
    });

    it("returns 401 with wrong auth", async () => {
      const res = await request("/stats", { headers: authHeader("wrong-key") });
      assert.equal(res.status, 401);
    });

    it("returns 200 with valid auth", async () => {
      const res = await request("/stats", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json, "response should be valid JSON");
    });
  });

  // ── /providers ──────────────────────────────────────────────────────────
  describe("GET /providers", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/providers");
      assert.equal(res.status, 401);
    });

    it("returns provider details when authenticated", async () => {
      const res = await request("/providers", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json.providers, "should contain providers object");
      assert.ok(res.json.providers.fakeprov, "should contain fakeprov");
      assert.equal(res.json.providers.fakeprov.keys, 2, "fakeprov should have 2 keys");
    });
  });

  // ── /families ──────────────────────────────────────────────────────────
  describe("GET /families", () => {
    it("returns 401 without auth", async () => {
      const res = await request("/families");
      assert.equal(res.status, 401);
    });

    it("returns family groupings when authenticated", async () => {
      const res = await request("/families", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 200);
      assert.ok(res.json.families, "should contain families object");
      assert.ok(res.json.families.testfam, "should contain testfam family");
      assert.ok(
        Array.isArray(res.json.families.testfam),
        "family members should be an array"
      );
      assert.ok(
        res.json.families.testfam.includes("fakeprov"),
        "testfam should include fakeprov"
      );
    });
  });

  // ── Family proxy: /family/{name}/v1/* ─────────────────────────────────
  describe("POST /family/{name}/v1/chat/completions", () => {
    it("returns 502 from fake upstream (proves family routing works)", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/family/testfam/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeader(FFAI_KEY),
          "content-type": "application/json",
        },
        body,
      });
      // Should route to a provider in testfam but fail at upstream
      assert.ok(
        [502, 503].includes(res.status),
        `expected 502 or 503, got ${res.status}: ${res.body}`
      );
    });

    it("returns error for unknown family", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/family/nonexistent/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeader(FFAI_KEY),
          "content-type": "application/json",
        },
        body,
      });
      // Unknown family → acquireFromFamily returns null → 429 "All keys rate limited"
      assert.equal(res.status, 429, `expected 429 for unknown family, got ${res.status}: ${res.body}`);
      assert.ok(res.json, "response should be valid JSON");
    });
  });

  // ── Proxy route: /{provider}/v1/* ───────────────────────────────────────
  describe("POST /{provider}/v1/chat/completions", () => {
    it("returns 401 without auth", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/fakeprov/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 401);
    });

    it("returns 502 or connection error for fake upstream (proves routing works)", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/fakeprov/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeader(FFAI_KEY),
          "content-type": "application/json",
        },
        body,
      });
      // The request should route to fakeprov but fail at the upstream level.
      // We expect 502 (upstream error) since nothing listens on the fake URL.
      assert.ok(
        [502, 503].includes(res.status),
        `expected 502 or 503, got ${res.status}: ${res.body}`
      );
    });

    it("includes x-ffai-provider and x-ffai-latency-ms headers", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/fakeprov/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeader(FFAI_KEY),
          "content-type": "application/json",
        },
        body,
      });
      // Even on a 502 from the upstream, the headers should be set on error paths.
      // The server sets them in the success path (piped response), but on error
      // it returns a JSON body via sendJson, which may or may not include them.
      // Check if provider header is present — it is included on successful
      // upstream connections (even if status >= 400). On connection errors (502),
      // the error JSON body includes the provider field instead.
      if (res.headers["x-ffai-provider"]) {
        assert.equal(res.headers["x-ffai-provider"], "fakeprov");
        assert.ok(res.headers["x-ffai-latency-ms"], "x-ffai-latency-ms should be present");
        const latency = Number(res.headers["x-ffai-latency-ms"]);
        assert.ok(!isNaN(latency), "x-ffai-latency-ms should be a number");
        assert.ok(latency >= 0, "latency should be non-negative");
      } else {
        // On connection error, provider is in the JSON body
        assert.ok(res.json, "response should be valid JSON");
        assert.equal(res.json.provider, "fakeprov", "error body should include provider");
      }
    });
  });

  // ── Unknown provider ──────────────────────────────────────────────────
  describe("Unknown provider", () => {
    it("returns 404 for unknown provider route", async () => {
      const body = JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
      });
      const res = await request("/nonexistent/v1/chat/completions", {
        method: "POST",
        headers: {
          ...authHeader(FFAI_KEY),
          "content-type": "application/json",
        },
        body,
      });
      assert.equal(res.status, 404);
      assert.ok(res.json.error.includes("unknown provider"), `error should mention unknown provider: ${res.json.error}`);
    });
  });

  // ── 404 for unknown routes ────────────────────────────────────────────
  describe("Unknown routes", () => {
    it("returns 404 for completely unknown paths", async () => {
      const res = await request("/nonexistent-route", { headers: authHeader(FFAI_KEY) });
      assert.equal(res.status, 404);
    });
  });
});

// ── Second server instance for 429 exhaustion ────────────────────────────────
describe("serve.js 429 exhaustion", () => {
  let child429;
  let port429;
  let base429;
  const tmpDir429 = fs.mkdtempSync(path.join(os.tmpdir(), "ffai-429-test-"));
  const configFile429 = path.join(tmpDir429, "config.json");
  const statsFile429 = path.join(tmpDir429, "stats.json");

  // Config with 2 keys and key_cb_threshold: 1 so one error trips each key's breaker.
  // Need 2+ keys because single-key groups have elevated protection thresholds.
  const exhaustConfig = {
    providers: {
      singleprov: {
        keys: ["key-one", "key-two"],
        upstream_url: "https://localhost:19999",
        auth_scheme: "bearer",
        rpm_limit: 100,
        tpm_limit: 100000,
        rpd_limit: 1000,
        default_cooldown: 5,
        max_cooldown: 10,
        retryable_statuses: [429, 502, 503],
        key_cb_threshold: 1,
        key_cb_cooldown: 60000,
      },
    },
  };

  fs.writeFileSync(configFile429, JSON.stringify(exhaustConfig, null, 2));

  function request429(urlPath, opts = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, base429);
      const reqOpts = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: 10000,
      };
      const req = http.request(reqOpts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json;
          try { json = JSON.parse(body); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("request timeout")); });
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  before(async () => {
    child429 = spawn(NODE_BIN, [SERVE_JS], {
      env: {
        ...process.env,
        FFAI_PORT: "0",
        FFAI_BIND: "127.0.0.1",
        FFAI_KEY: FFAI_KEY,
        FFAI_ADMIN_KEY: ADMIN_KEY,
        FFAI_CONFIG: configFile429,
        FFAI_STATS_FILE: statsFile429,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const portPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("429-server did not start")), 10000);
      let buf = "";
      child429.stdout.on("data", (d) => {
        buf += d.toString();
        const match = buf.match(/Bridge listening on [^:]+:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child429.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`429-server exited ${code}`));
      });
    });

    let stderr = "";
    child429.stderr.on("data", (d) => { stderr += d.toString(); });
    child429.on("exit", (code) => {
      if (code && code !== 0 && code !== null) {
        console.error(`[test-429] serve.js exited with code ${code}\n${stderr}`);
      }
    });

    port429 = await portPromise;
    base429 = `http://127.0.0.1:${port429}`;

    await waitForServer(base429);
  });

  after(() => {
    if (child429 && !child429.killed) child429.kill("SIGTERM");
    try { fs.rmSync(tmpDir429, { recursive: true, force: true }); } catch {}
  });

  it("returns 429 when all keys are circuit-broken", async () => {
    const body = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
    });
    const hdrs = {
      ...authHeader(FFAI_KEY),
      "content-type": "application/json",
    };

    // With key_cb_threshold: 1 and a single key, the first request's internal
    // retry loop will: attempt 0 → upstream fails → circuit-break the key →
    // attempt 1 → acquire returns null → respond 429.
    const res = await request429("/singleprov/v1/chat/completions", {
      method: "POST",
      headers: hdrs,
      body,
    });
    assert.equal(res.status, 429, `expected 429, got ${res.status}: ${res.body}`);
    assert.ok(res.json, "429 response should be valid JSON");
    assert.equal(res.json.error, "All keys rate limited");
  });
});
