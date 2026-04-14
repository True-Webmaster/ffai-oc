/**
 * Integration tests for /generate-import and /import endpoints.
 *
 * These spawn a real serve.js child process against a temp config and
 * exercise the full encryption round-trip. They replicate the browser
 * side of the encrypt.html flow in Node so we can test without a headless
 * browser — the crypto primitives are the same (PBKDF2-SHA256 600k iters,
 * AES-256-GCM, 16-byte auth tag appended to ciphertext).
 *
 * Covers:
 *   - /generate-import happy path (HTML page returned, token persisted)
 *   - /generate-import auth rejection
 *   - /import with unknown token → 403, audit "unknown_token"
 *   - /import with valid token but bad ciphertext → 403, audit "decrypt_failed"
 *   - /import with malformed JSON → 400
 *   - /import with missing payload field → 400
 *   - /import full round-trip success → keys installed in config, token consumed
 *   - /import with invalid keys (too short) → rejected
 *   - /import with duplicate keys → counted but not added
 *   - /import token single-use (second attempt with same token fails)
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const FFAI_KEY = "test-import-key-xyz";
const ADMIN_KEY = "test-import-key-xyz";
const NODE_BIN = process.execPath;
const SERVE_JS = path.join(__dirname, "..", "serve.js");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffai-import-test-"));
const configFile = path.join(tmpDir, "config.json");
const statsFile = path.join(tmpDir, "stats.json");
const auditFile = path.join(tmpDir, "import-audit.log");

// Seed config with one provider that has one pre-existing key, so we can
// test dedup against it.
const testConfig = {
  providers: {
    testprov: {
      keys: ["existing-key-original-12345"],
      upstream_url: "https://localhost:19999",
      auth_scheme: "bearer",
      rpm_limit: 10,
      tpm_limit: 100000,
      rpd_limit: 1000,
      family: "testfam",
    },
  },
  import_tokens: [],
};

fs.writeFileSync(configFile, JSON.stringify(testConfig, null, 2));

// ── HTTP helper ─────────────────────────────────────────────────────────────

let PORT;
let BASE;

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

// ── Crypto: replicate the browser encryption logic from encrypt.html ────────
//
// The HTML page uses WebCrypto:
//   key = PBKDF2(password=token, salt, 600_000, SHA-256, 32 bytes)
//   ct  = AES-256-GCM(key, iv, plaintext)  // 16-byte tag APPENDED to ct
//
// Envelope: { v: 1, id, salt: b64, iv: b64, ct: b64 }

function encryptPayload(token, plaintextObj) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(token, salt, 600000, 32, "sha256");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Serve expects tag appended to ct (matches the browser code path)
  const ct = Buffer.concat([encrypted, authTag]);
  return {
    v: 1,
    id: token.substring(0, 8),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function envelopeToPayload(envelope) {
  const blob = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return `FFAI-IMPORT:${blob}`;
}

// ── Parse token from HTML page ──────────────────────────────────────────────

function extractTokenFromHtml(html) {
  // generateImportHtml embeds the token via: const TOKEN = JSON.stringify(token);
  // which serializes to: const TOKEN = "<64 hex chars>";
  const match = html.match(/const TOKEN = "([a-f0-9]{64})"/);
  assert.ok(match, "HTML must contain TOKEN constant");
  return match[1];
}

// ── Read audit log ──────────────────────────────────────────────────────────

function readAuditLog() {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// ── Spawn serve.js ──────────────────────────────────────────────────────────

let child;

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
        headers: authHeader(FFAI_KEY),
      }, (res) => { res.resume(); resolve(); });
      probe.on("error", () => setTimeout(attempt, 80));
      probe.end();
    })();
  });
}

describe("Import endpoints (/generate-import, /import)", { concurrency: 1 }, () => {
  before(async () => {
    child = spawn(NODE_BIN, [SERVE_JS], {
      cwd: tmpDir, // so import-audit.log lands in tmpDir
      env: {
        ...process.env,
        FFAI_PORT: "0",
        FFAI_BIND: "127.0.0.1",
        FFAI_KEY,
        FFAI_ADMIN_KEY: ADMIN_KEY,
        FFAI_CONFIG: configFile,
        FFAI_STATS_FILE: statsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const portPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("server did not print listening line")), 10000);
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/Bridge listening on [^:]+:(\d+)/);
        if (m) { clearTimeout(timeout); resolve(Number(m[1])); }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`serve.js exited with code ${code} before printing port`));
      });
    });

    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("exit", (code) => {
      if (code && code !== 0 && code !== null) {
        console.error(`[test] serve.js exited ${code}\n${stderr}`);
      }
    });

    PORT = await portPromise;
    BASE = `http://127.0.0.1:${PORT}`;
    await waitForServer(BASE);
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── /generate-import ────────────────────────────────────────────────────

  describe("GET /generate-import", () => {
    it("rejects unauthenticated requests", async () => {
      const res = await request("/generate-import");
      assert.equal(res.status, 401);
    });

    it("returns an HTML page with an embedded token when authenticated", async () => {
      const res = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"] || "", /text\/html/);
      assert.ok(res.body.length > 1000, "HTML should be non-trivial");
      // The token is what the browser will PBKDF2-derive the key from
      const token = extractTokenFromHtml(res.body);
      assert.equal(token.length, 64, "token should be 64 hex chars (32 bytes)");
    });

    it("persists the generated token to config.json", async () => {
      const before = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const beforeCount = (before.import_tokens || []).length;

      const res = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(res.status, 200);
      const token = extractTokenFromHtml(res.body);

      const after = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.equal((after.import_tokens || []).length, beforeCount + 1);
      const latest = after.import_tokens[after.import_tokens.length - 1];
      assert.equal(latest.token, token);
      assert.equal(latest.id, token.substring(0, 8));
      assert.ok(latest.created, "token should have created timestamp");
    });
  });

  // ── /import error paths ─────────────────────────────────────────────────

  describe("POST /import — error paths", () => {
    it("400 on malformed JSON body", async () => {
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: "not valid json",
      });
      assert.equal(res.status, 400);
      assert.match(res.json?.error || "", /invalid JSON/i);
    });

    it("400 when payload field is missing", async () => {
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.match(res.json?.error || "", /missing payload/i);
    });

    it("400 when envelope version is unsupported", async () => {
      const env = { v: 99, id: "deadbeef", salt: "AA==", iv: "AA==", ct: "AA==" };
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 400);
      assert.match(res.json?.error || "", /unsupported payload version/i);
    });

    it("403 for unknown token ID (logged as 'unknown_token')", async () => {
      const env = { v: 1, id: "deadbeef", salt: "AAAAAAAAAAAAAAAAAAAAAA==", iv: "AAAAAAAAAAAAAAAA", ct: "AAAAAAAAAAAAAAAAAAAAAA==" };
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 403);

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_failed" && e.tokenId === "deadbeef");
      assert.ok(hit, "audit log should have an entry for the unknown token");
      assert.equal(hit.reason, "unknown_token");
    });

    it("403 for valid token ID with bad ciphertext (logged as 'decrypt_failed')", async () => {
      // First: generate a fresh token so we have a valid ID on record
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(genRes.status, 200);
      const token = extractTokenFromHtml(genRes.body);
      const id = token.substring(0, 8);

      // Now craft an envelope with the real ID but garbage ciphertext
      const env = {
        v: 1,
        id,
        salt: Buffer.alloc(16, 0).toString("base64"),
        iv: Buffer.alloc(12, 0).toString("base64"),
        ct: Buffer.alloc(32, 0).toString("base64"),
      };
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 403);
      // Same error text as unknown token (no oracle)
      assert.match(res.json?.error || "", /import failed/i);

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_failed" && e.tokenId === id && e.reason === "decrypt_failed");
      assert.ok(hit, "audit log should have decrypt_failed entry");
    });
  });

  // ── /import happy path ──────────────────────────────────────────────────

  describe("POST /import — successful round-trip", () => {
    it("installs new keys, dedups existing, consumes token", async () => {
      // Generate token
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const token = extractTokenFromHtml(genRes.body);
      const id = token.substring(0, 8);

      // Encrypt payload: one new key, one duplicate of the pre-existing key,
      // one too-short invalid key
      const plaintext = {
        provider: "testprov",
        keys: [
          "fresh-new-key-from-import-abc",
          "existing-key-original-12345", // duplicate
          "short",                       // invalid (< 8 chars)
        ],
      };
      const envelope = encryptPayload(token, plaintext);
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(envelope) }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      assert.equal(res.json.imported, 1);
      assert.equal(res.json.duplicates, 1);
      assert.equal(res.json.invalid, 1);
      assert.equal(res.json.provider, "testprov");

      // Config must now contain the new key
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.ok(cfg.providers.testprov.keys.includes("fresh-new-key-from-import-abc"),
        "new key must be written to config.json");
      assert.ok(cfg.providers.testprov.keys.includes("existing-key-original-12345"),
        "pre-existing key must remain");

      // Token must be consumed (removed from import_tokens)
      const stillThere = (cfg.import_tokens || []).some((t) => t.id === id);
      assert.equal(stillThere, false, "token should be consumed after successful import");

      // Audit log should record the success
      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_success" && e.tokenId === id);
      assert.ok(hit, "audit log should have import_success entry");
      assert.equal(hit.imported, 1);
      assert.equal(hit.duplicates, 1);
      assert.equal(hit.invalid, 1);
    });

    it("rejects a second use of a consumed token", async () => {
      // Generate and use a token
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const token = extractTokenFromHtml(genRes.body);

      const plaintext = { provider: "testprov", keys: ["single-use-key-xyz-99999"] };
      const envelope = encryptPayload(token, plaintext);
      const payload = JSON.stringify({ payload: envelopeToPayload(envelope) });

      const first = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: payload,
      });
      assert.equal(first.status, 200);

      // Second attempt with the SAME envelope — should now fail because the
      // token was consumed. The audit log should record it as unknown_token.
      const second = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: payload,
      });
      assert.equal(second.status, 403);
    });
  });
});
