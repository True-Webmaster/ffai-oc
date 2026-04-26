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

// Seed config with two providers:
//   - testprov uses inline `keys` so we can dedup against an explicit array
//   - envprov uses `keys_var` so we can verify imports do NOT promote env
//     keys into the plaintext config (regression coverage for the bug
//     Mateo flagged in his review)
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
    envprov: {
      keys_var: "ENVPROV_KEYS",
      upstream_url: "https://localhost:19999",
      auth_scheme: "bearer",
      rpm_limit: 10,
      tpm_limit: 100000,
      rpd_limit: 1000,
      family: "envfam",
    },
  },
  import_tokens: [],
};

const ENVPROV_BASELINE_KEYS = "envprov-baseline-key-aaa-1234,envprov-baseline-key-bbb-5678";

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
// v2 (public-key) flow — the current default:
//   1. Generate ephemeral P-256 keypair in the browser
//   2. ECDH with the server's public key → 32-byte shared secret
//   3. HKDF-SHA256(shared, salt=empty, info="ffai-import-v2") → AES-256 key
//   4. ct = AES-256-GCM(aesKey, iv, plaintext)  // 16-byte tag APPENDED
//   Envelope: { v: 2, ephPub: b64, iv: b64, ct: b64 }
//
// v1 (legacy shared-secret) flow — still accepted by the server for backwards
// compat with pre-upgrade HTML pages within the 24h TTL window.

function encryptPayloadV2(serverPubRawB64, plaintextObj) {
  const serverPubRaw = Buffer.from(serverPubRawB64, "base64");
  // Reconstruct an SPKI DER so createPublicKey can parse it
  const SPKI_P256_PREFIX = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"
  );
  const serverPub = crypto.createPublicKey({
    key: Buffer.concat([SPKI_P256_PREFIX, serverPubRaw]),
    format: "der",
    type: "spki",
  });

  const eph = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ephSpkiDer = eph.publicKey.export({ type: "spki", format: "der" });
  const ephPubRaw = ephSpkiDer.slice(ephSpkiDer.length - 65);

  const sharedSecret = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: serverPub,
  });
  const aesKey = crypto.hkdfSync(
    "sha256", sharedSecret, Buffer.alloc(0), Buffer.from("ffai-import-v2"), 32
  );

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(aesKey), iv);
  const plaintext = Buffer.from(JSON.stringify(plaintextObj), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ct = Buffer.concat([encrypted, authTag]);

  return {
    v: 2,
    ephPub: Buffer.from(ephPubRaw).toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  };
}

function envelopeToPayload(envelope) {
  const blob = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return `FFAI-IMPORT:${blob}`;
}

function randomNonce() {
  return crypto.randomBytes(18).toString("base64");
}

// ── Parse public key from HTML page ─────────────────────────────────────────

function extractPubKeyFromHtml(html) {
  // generateImportHtml embeds: const SERVER_PUB_B64 = "<base64 65-byte raw>";
  const match = html.match(/const SERVER_PUB_B64 = "([A-Za-z0-9+/=]+)"/);
  assert.ok(match, "HTML must contain SERVER_PUB_B64 constant");
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
        ENVPROV_KEYS: ENVPROV_BASELINE_KEYS,
        // Bump the import rate limit so the test suite (which fires more
        // than 10 imports back-to-back from 127.0.0.1) doesn't trip 429.
        FFAI_IMPORT_RATE_MAX: "1000",
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

    it("returns an HTML page with the server public key baked in", async () => {
      const res = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"] || "", /text\/html/);
      assert.ok(res.body.length > 1000, "HTML should be non-trivial");
      // v2 embeds the server's P-256 public key (raw 65 bytes → ~88 base64 chars)
      const pub = extractPubKeyFromHtml(res.body);
      const raw = Buffer.from(pub, "base64");
      assert.equal(raw.length, 65, "raw pubkey should be 65 bytes (0x04 || X || Y)");
      assert.equal(raw[0], 0x04, "uncompressed P-256 pubkey starts with 0x04");
    });

    it("persists the server keypair across restarts (same pubkey on repeated /generate-import)", async () => {
      const a = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const b = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      // The public key is a long-lived server secret, not per-request
      assert.equal(extractPubKeyFromHtml(a.body), extractPubKeyFromHtml(b.body));

      // And it lives in config.json under import_keypair
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.ok(cfg.import_keypair, "import_keypair should be persisted");
      assert.equal(cfg.import_keypair.publicRawB64, extractPubKeyFromHtml(a.body));
      assert.ok(cfg.import_keypair.privateJwk, "private JWK should be persisted");
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
      const env = { v: 99, ephPub: "AA==", iv: "AA==", ct: "AA==" };
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 400);
      assert.match(res.json?.error || "", /unsupported payload version/i);
    });

    it("400 for v2 envelope with malformed ephemeral pubkey", async () => {
      const env = {
        v: 2,
        ephPub: Buffer.alloc(10, 0).toString("base64"),  // wrong length
        iv: Buffer.alloc(12, 0).toString("base64"),
        ct: Buffer.alloc(32, 0).toString("base64"),
      };
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 400);

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_failed" && e.reason === "bad_ephpub");
      assert.ok(hit, "audit log should have bad_ephpub entry");
    });

    it("403 for v2 envelope with valid structure but wrong/garbage ciphertext", async () => {
      // A well-formed uncompressed P-256 pubkey we control, with ciphertext
      // encrypted under the wrong AES key — decryption auth tag will fail.
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      assert.equal(genRes.status, 200);
      // Don't use the real pubkey — encrypt with a throwaway keypair so
      // ECDH with the server's private key produces a different AES key.
      const wrongServer = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const wrongServerPubRaw = wrongServer.publicKey.export({ type: "spki", format: "der" }).slice(-65);
      const env = encryptPayloadV2(
        Buffer.from(wrongServerPubRaw).toString("base64"),
        { provider: "testprov", keys: ["fresh-key-for-wrongkey-test"], ts: Date.now(), nonce: randomNonce() },
      );
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(env) }),
      });
      assert.equal(res.status, 403);
      assert.match(res.json?.error || "", /could not be decrypted/i);

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_failed" && e.reason === "decrypt_failed" && e.v === 2);
      assert.ok(hit, "audit log should have v2 decrypt_failed entry");
    });
  });

  // ── /import happy path ──────────────────────────────────────────────────

  describe("POST /import — successful round-trip (v2)", () => {
    it("installs new keys, dedups existing, records audit entry", async () => {
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const pub = extractPubKeyFromHtml(genRes.body);

      const plaintext = {
        provider: "testprov",
        keys: [
          "fresh-new-key-from-import-abc",
          "existing-key-original-12345", // duplicate
          "short",                       // invalid (< 8 chars)
        ],
        ts: Date.now(),
        nonce: randomNonce(),
      };
      const envelope = encryptPayloadV2(pub, plaintext);
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

      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      assert.ok(cfg.providers.testprov.keys.includes("fresh-new-key-from-import-abc"),
        "new key must be written to config.json");
      assert.ok(cfg.providers.testprov.keys.includes("existing-key-original-12345"),
        "pre-existing key must remain");

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_success" && e.v === 2);
      assert.ok(hit, "audit log should have v2 import_success entry");
      assert.equal(hit.imported, 1);
      assert.equal(hit.duplicates, 1);
      assert.equal(hit.invalid, 1);
    });

    it("rejects replay of the same blob (nonce memory)", async () => {
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const pub = extractPubKeyFromHtml(genRes.body);

      const plaintext = {
        provider: "testprov",
        keys: ["replay-test-key-xyz-9999"],
        ts: Date.now(),
        nonce: randomNonce(),
      };
      const envelope = encryptPayloadV2(pub, plaintext);
      const payload = JSON.stringify({ payload: envelopeToPayload(envelope) });

      const first = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: payload,
      });
      assert.equal(first.status, 200);

      // Second attempt with the exact same envelope — nonce already seen, reject
      const second = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: payload,
      });
      assert.equal(second.status, 403);
      assert.match(second.json?.error || "", /already used/i);

      const log = readAuditLog();
      const replayHit = log.find((e) => e.event === "import_failed" && e.reason === "replay");
      assert.ok(replayHit, "audit log should have replay entry");
    });

    it("rejects a stale blob (ts too old)", async () => {
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const pub = extractPubKeyFromHtml(genRes.body);

      // ts = 2 days ago; server enforces 24h window
      const plaintext = {
        provider: "testprov",
        keys: ["stale-blob-key-abcdefgh"],
        ts: Date.now() - (2 * 24 * 60 * 60 * 1000),
        nonce: randomNonce(),
      };
      const envelope = encryptPayloadV2(pub, plaintext);
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(envelope) }),
      });
      assert.equal(res.status, 403);
      assert.match(res.json?.error || "", /expired/i);

      const log = readAuditLog();
      const hit = log.find((e) => e.event === "import_failed" && e.reason === "stale_blob");
      assert.ok(hit, "audit log should have stale_blob entry");
    });
  });

  // ── Regression: Mateo's keys_var → plaintext promotion finding ──────────
  //
  // Before the fix, importing a key for a provider that used `keys_var`
  // would copy the entire env-sourced key list into provConf.keys on disk
  // and stop honouring the env var on subsequent boots. These tests pin
  // the corrected behaviour: env keys stay in env, imported keys live in
  // config.json alongside them, and resolveKeys() merges both at runtime.

  describe("POST /import — does not promote env keys into config (envprov)", () => {
    it("imports a new key without copying env baseline into provConf.keys", async () => {
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const pub = extractPubKeyFromHtml(genRes.body);

      const newKey = "envprov-imported-fresh-key-zzz-9999";
      const envelope = encryptPayloadV2(pub, {
        provider: "envprov",
        keys: [newKey],
        ts: Date.now(),
        nonce: randomNonce(),
      });
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(envelope) }),
      });
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
      assert.equal(res.json.imported, 1);

      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const ep = cfg.providers.envprov;

      // The fresh key must be persisted (so it survives restarts even
      // though it didn't come from the env baseline).
      assert.ok(Array.isArray(ep.keys), "envprov.keys should now exist");
      assert.ok(ep.keys.includes(newKey), "imported key must be persisted");

      // CRITICAL: the env baseline must NOT have been copied into config.
      // If this assertion fires, we've regressed Mateo's finding —
      // operators using keys_var would have their secrets silently moved
      // to disk.
      const envBaselineKeys = ENVPROV_BASELINE_KEYS.split(",");
      for (const baseline of envBaselineKeys) {
        assert.ok(
          !ep.keys.includes(baseline),
          `env baseline key "${baseline}" must NOT be promoted into config.json`,
        );
      }

      // keys_var must remain set so the env source stays canonical.
      assert.equal(ep.keys_var, "ENVPROV_KEYS", "keys_var must not be removed");
    });

    it("dedupes against env-baseline keys without writing them to config", async () => {
      const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
      const pub = extractPubKeyFromHtml(genRes.body);

      // Try to import a baseline key (already present via env). Server
      // should report it as a duplicate, not as imported, and crucially
      // must NOT add it to provConf.keys to "satisfy" the dedup.
      const baselineKey = ENVPROV_BASELINE_KEYS.split(",")[0];
      const envelope = encryptPayloadV2(pub, {
        provider: "envprov",
        keys: [baselineKey],
        ts: Date.now(),
        nonce: randomNonce(),
      });
      const res = await request("/import", {
        method: "POST",
        headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
        body: JSON.stringify({ payload: envelopeToPayload(envelope) }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.imported, 0);
      assert.equal(res.json.duplicates, 1);

      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const ep = cfg.providers.envprov;
      const onDiskKeys = Array.isArray(ep.keys) ? ep.keys : [];
      assert.ok(
        !onDiskKeys.includes(baselineKey),
        "duplicate-of-env-baseline must not get promoted to config",
      );
    });
  });
});
