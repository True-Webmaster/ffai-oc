/**
 * FFAI — Free Freaking AI
 *
 * Zero-dependency key-pooling proxy for free-tier LLM APIs.
 * Rotates API keys with smart scoring, free-tier rate limit awareness,
 * provider-specific 429 parsing, daily reset clocks, and pre-flight
 * capacity checks. OpenAI-compatible API — drop-in for anything that
 * speaks /v1/chat/completions.
 *
 * Usage:
 *   node serve.js                        # reads config.json + .env
 *   FFAI_PORT=8010 node serve.js         # custom port
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Pool = require("./lib/pool");
const AuthGuard = require("./lib/auth-guard");
const { sanitize } = require("./lib/sanitizer");
const { estimateInputTokens } = require("./lib/utils");
const { parse429 } = require("./lib/error-parser");
const DeprecationTracker = require("./lib/deprecation-tracker");
const ModelDiscovery = require("./lib/model-discovery");
const CapabilityStore = require("./lib/capabilities");
const { validateConfig } = require("./lib/config-validator");
const { smush, resetSmush, getSmushStats } = require("./lib/smush");

// ── Safe env parsing helper ─────────────────────────────────────────────────
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v) || v < 0) {
    console.error(`[ffai] WARNING: ${name}="${raw}" is not a valid non-negative integer, using default ${fallback}`);
    return fallback;
  }
  return v;
}

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = envInt("FFAI_PORT", parseInt(process.env.PORT || "8010", 10));
const BIND = (process.env.FFAI_BIND || "127.0.0.1").trim();
const FFAI_KEY = (process.env.FFAI_KEY || "").trim();
const ADMIN_KEY = (process.env.FFAI_ADMIN_KEY || "").trim();
const CONFIG_FILE = process.env.FFAI_CONFIG || path.join(__dirname, "config.json");
const STATS_FILE = process.env.FFAI_STATS_FILE || path.join(__dirname, "data", "stats.json");
const REQUEST_TIMEOUT = envInt("FFAI_REQUEST_TIMEOUT", 120000);
const MAX_BODY_SIZE = envInt("FFAI_MAX_BODY_SIZE", 2 * 1024 * 1024);
const ALERT_WEBHOOK_URL = (process.env.FFAI_ALERT_WEBHOOK || "").trim();
const VALIDATE_KEYS = process.env.FFAI_VALIDATE_KEYS === "true" || process.env.FFAI_VALIDATE_KEYS === "1";
const SSE_TIMEOUT = envInt("FFAI_SSE_TIMEOUT", 0); // 0 = auto (3x REQUEST_TIMEOUT, min 360s)
const STATS_RETENTION_DAYS = envInt("FFAI_STATS_RETENTION_DAYS", 7);
const STATS_FLUSH_INTERVAL = envInt("FFAI_STATS_FLUSH_INTERVAL", 60000);
const DISCOVERY_TIMEOUT = envInt("FFAI_DISCOVERY_TIMEOUT", 30000);
const DISCOVERY_SOCKET_TIMEOUT = envInt("FFAI_DISCOVERY_SOCKET_TIMEOUT", 15000);
const DISCOVERY_SPEC_TIMEOUT = envInt("FFAI_DISCOVERY_SPEC_TIMEOUT", 30000);
const MIN_CONTEXT_WINDOW = envInt("FFAI_MIN_CONTEXT_WINDOW", 32768);
const MIN_OUTPUT_TOKENS = envInt("FFAI_MIN_OUTPUT_TOKENS", 4096);
const MIN_PARAM_BILLIONS = envInt("FFAI_MIN_PARAM_BILLIONS", 4);
const ALERT_TIMEOUT = envInt("FFAI_ALERT_TIMEOUT", 5000);
const MAX_CAPABILITY_MODELS = envInt("FFAI_MAX_CAPABILITY_MODELS", 2000);
const AUTH_FAIL_MAX = envInt("FFAI_AUTH_FAIL_MAX", 10);
const AUTH_FAIL_WINDOW = envInt("FFAI_AUTH_FAIL_WINDOW", 60000);
const AUTH_BLOCK_DURATION = envInt("FFAI_AUTH_BLOCK_DURATION", 300000);
const VALIDATE_TIMEOUT = envInt("FFAI_VALIDATE_TIMEOUT", 10000);

// ── SSE connection tracking for graceful shutdown ──────────────────────────
const activeSSEConnections = new Set();

// ── Models cache (TTL-based) ───────────────────────────────────────────────
const MODELS_CACHE_TTL = envInt("FFAI_MODELS_CACHE_TTL", 300000); // 5 min
let _modelsCache = null;
let _modelsCacheTs = 0;

if (process.env.FFAI_KEY && !FFAI_KEY) {
  console.error("[ffai] FATAL: FFAI_KEY is set but empty after trimming");
  process.exit(1);
}
if (!FFAI_KEY && BIND !== "127.0.0.1" && BIND !== "localhost" && BIND !== "::1") {
  console.error("[ffai] *** WARNING: FFAI_KEY is not set and FFAI_BIND=" + BIND + " — API keys are UNPROTECTED on the network! ***");
  console.error("[ffai] Set FFAI_KEY in .env or bind to 127.0.0.1 for safety.");
}

// ── Load config ─────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error(`[ffai] FATAL: Cannot load ${CONFIG_FILE}: ${err.message}`);
    process.exit(1);
  }
}

/** Safe config loader for hot-reload — returns null on failure instead of exiting. */
function tryLoadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    console.error(`[ffai] Config reload failed: ${err.message}`);
    return null;
  }
}

function resolveKeys(provConfig) {
  if (Array.isArray(provConfig.keys) && provConfig.keys.length > 0) return provConfig.keys;
  if (provConfig.keys_var) {
    return (process.env[provConfig.keys_var] || "").split(",").map(k => k.trim()).filter(Boolean);
  }
  return [];
}

const config = loadConfig();

// Holder for the v2 public-key import keypair. Populated below after config
// validation. Declared here so the helper functions further down (which close
// over it) are linked to the same binding — and so we can assign into it from
// the initialization block without tripping the TDZ for the later definition.
let _importKeypair = null;

// ── Config validation ─────────────────────────────────────────────────────────
{
  const { errors, warnings } = validateConfig(config);
  for (const w of warnings) console.warn(`[ffai:config] WARNING: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[ffai:config] ERROR: ${e}`);
    console.error(`[ffai] FATAL: ${errors.length} config validation error(s)`);
    process.exit(1);
  }
}

// Initialize the public-key import keypair (v2). Generated on first boot
// and persisted into config.json; regenerated transparently if storage
// becomes corrupted. Must run AFTER config validation but BEFORE the HTTP
// server starts handling /pubkey or /generate-import.
_importKeypair = loadOrCreateImportKeypair(config);

// Build provider configs with upstream URLs for proxying
const providerConfigs = {};
const upstreamUrls = {}; // provider → upstream base URL
const providerTimeouts = {}; // provider → request timeout ms
const providerAcquireWait = {}; // provider → custom acquire wait ms

for (const [name, pconf] of Object.entries(config.providers || {})) {
  const resolved = { ...pconf, keys: resolveKeys(pconf) };
  providerConfigs[name] = resolved;
  upstreamUrls[name] = (pconf.upstream_url || "").replace(/\/+$/, "");
  if (pconf.request_timeout) providerTimeouts[name] = pconf.request_timeout;
  if (pconf.acquire_wait_ms != null) providerAcquireWait[name] = pconf.acquire_wait_ms;
}

const pool = new Pool({
  providers: providerConfigs,
  statsFile: STATS_FILE,
  statsFlushInterval: STATS_FLUSH_INTERVAL,
  statsRetentionDays: STATS_RETENTION_DAYS,
  alertWebhookUrl: ALERT_WEBHOOK_URL,
  alertTimeoutMs: ALERT_TIMEOUT,
  alertEventTtls: config.alert_ttls || {},
  pricing: config.pricing || {},
});


// __ Model pricing for savings estimation ($ per 1M tokens) ________________
const MODEL_PRICING = {
  gemini:     { input: 1.25, output: 5.00 },    // Gemini 2.5 Pro avg
  groq:       { input: 0.05, output: 0.10 },    // Groq free-tier models avg
  cerebras:   { input: 0.10, output: 0.10 },    // Cerebras free-tier avg
  openai:     { input: 2.50, output: 10.00 },   // GPT-4.1 avg
  openrouter: { input: 1.00, output: 3.00 },    // OpenRouter avg
  mistral:    { input: 0.50, output: 1.50 },    // Mistral avg
  default:    { input: 0.50, output: 1.50 },    // Fallback
};

const deprecationTracker = new DeprecationTracker({ logger: console });
pool.deprecationTracker = deprecationTracker;

const capabilities = new CapabilityStore({ logger: console, maxModels: MAX_CAPABILITY_MODELS });
pool.capabilities = capabilities;

// ── Model Discovery ────────────────────────────────────────────────────────
pool._upstreamUrls = upstreamUrls; // expose for discovery to read
const MIN_TPM = envInt("FFAI_MIN_TPM", 20000);
const discovery = new ModelDiscovery({
  pool, logger: console, minTpm: MIN_TPM,
  minContextWindow: MIN_CONTEXT_WINDOW,
  minOutputTokens: MIN_OUTPUT_TOKENS,
  minParamBillions: MIN_PARAM_BILLIONS,
  discoveryTimeout: DISCOVERY_TIMEOUT,
  discoverySocketTimeout: DISCOVERY_SOCKET_TIMEOUT,
  specTimeout: DISCOVERY_SPEC_TIMEOUT,
});
pool.discovery = discovery;

// ── Auth ────────────────────────────────────────────────────────────────────
const authGuard = new AuthGuard({
  failMax: AUTH_FAIL_MAX,
  failWindow: AUTH_FAIL_WINDOW,
  blockDuration: AUTH_BLOCK_DURATION,
});

function checkAuth(req, requiredKey) {
  if (!requiredKey) return true;
  const ip = req.socket?.remoteAddress || "unknown";
  if (authGuard.isBlocked(ip)) return false;
  const ok = authGuard.checkAuth(req.headers, requiredKey);
  if (!ok) authGuard.recordFailure(ip);
  return ok;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

// ── Atomic config write (fix #6) ────────────────────────────────────────────
function writeConfigAtomic(configData) {
  const tmpPath = CONFIG_FILE + ".tmp." + process.pid;
  const json = JSON.stringify(configData, null, 2) + "\n";
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_FILE);
}

// ── Import rate limiter (fix #5) ────────────────────────────────────────────
const _importAttempts = new Map(); // ip -> { count, firstAttempt }
const IMPORT_RATE_WINDOW = 60000;  // 1 minute
const IMPORT_RATE_MAX = 10;        // max attempts per window

function checkImportRateLimit(ip) {
  const now = Date.now();
  const record = _importAttempts.get(ip);
  if (!record || (now - record.firstAttempt) > IMPORT_RATE_WINDOW) {
    _importAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  record.count++;
  if (record.count > IMPORT_RATE_MAX) return false;
  return true;
}

// Periodic cleanup of stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _importAttempts) {
    if ((now - rec.firstAttempt) > IMPORT_RATE_WINDOW * 2) _importAttempts.delete(ip);
  }
}, 120000);

// ── Import audit logger (fix #16) ───────────────────────────────────────────
const AUDIT_LOG_FILE = path.join(path.dirname(CONFIG_FILE), "import-audit.log");

function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try { fs.appendFileSync(AUDIT_LOG_FILE, line, { mode: 0o600 }); } catch {}
}

// ── Import session constants ───────────────────────────────────────────────
// TTL is the *only* time-based gate for v2 (public-key) imports: an HTML page
// older than this is refused. v1 (shared-secret) tokens still use this same
// TTL for backwards compat during the transition window.
const IMPORT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IMPORT_NONCE_TTL_MS = 24 * 60 * 60 * 1000; // 24h nonce memory for replay protection
const IMPORT_NONCE_MAX = 500; // ceiling on retained nonces (LRU-evicted)

// ── Public-key import keypair (v2) ──────────────────────────────────────────
// Persistent ECDH P-256 keypair stored in config.json under "import_keypair".
// The *public* half is baked into generated HTML pages; the *private* half
// never leaves the FFAI host. This replaces the v1 shared-secret model where
// the decryption token traveled alongside the ciphertext.
//
// Why P-256 over X25519: universal browser Web Crypto support (X25519 only
// landed in Safari 17+ and is still spotty on mobile). Security is equivalent
// for this use case — both give ~128-bit work factor.
//
// Declaration is hoisted manually to the top of the module via the earlier
// `let _importKeypair` binding so the keypair can be initialised immediately
// after config load (line ~127). The function below is a declaration, which
// is hoisted automatically.
function loadOrCreateImportKeypair(cfg) {
  const existing = cfg.import_keypair;
  if (existing && typeof existing === "object" && existing.privateJwk && existing.publicRawB64) {
    try {
      const privateKeyObj = crypto.createPrivateKey({ key: existing.privateJwk, format: "jwk" });
      return {
        publicJwk: existing.publicJwk,
        publicRawB64: existing.publicRawB64,
        privateKeyObj,
      };
    } catch (err) {
      console.warn(`[ffai] import_keypair load failed (${err.message}); regenerating`);
    }
  }

  // Generate a fresh keypair. SPKI DER for P-256 uncompressed pubkey is 91
  // bytes; the final 65 bytes are the raw `04 || X || Y` form the browser's
  // importKey('raw', …) expects. JWK form is stored for portability.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const publicRawB64 = Buffer.from(spkiDer.slice(spkiDer.length - 65)).toString("base64");

  cfg.import_keypair = { publicJwk, privateJwk, publicRawB64, created: new Date().toISOString() };
  try {
    writeConfigAtomic(cfg);
  } catch (err) {
    console.error(`[ffai] Failed to persist import_keypair: ${err.message}`);
    // Still usable in-memory for this process lifetime.
  }
  console.log("[ffai] Generated new import_keypair (P-256)");
  return { publicJwk, publicRawB64, privateKeyObj: privateKey };
}

// Replay protection: remember nonces from accepted v2 imports so an attacker
// who captures a blob cannot re-submit the same decrypted payload. Map of
// nonce → expiresAt (ms since epoch). LRU-evict oldest when size exceeds max.
const _importNonces = new Map();

function rememberImportNonce(nonce) {
  if (typeof nonce !== "string" || nonce.length < 16) return false;
  if (_importNonces.has(nonce)) return false; // replay
  // Evict expired
  const now = Date.now();
  for (const [n, exp] of _importNonces) {
    if (exp < now) _importNonces.delete(n);
  }
  // Hard cap (LRU by insertion order — Map iterates in insertion order)
  while (_importNonces.size >= IMPORT_NONCE_MAX) {
    const oldest = _importNonces.keys().next().value;
    _importNonces.delete(oldest);
  }
  _importNonces.set(nonce, now + IMPORT_NONCE_TTL_MS);
  return true;
}

// ── Provider key fingerprints ──────────────────────────────────────────────
// Used by /import to reject mislabeled keys before they land in a pool where
// every rotation would 401 and silently trip circuit breakers. Kept in sync
// with the KEY_PATTERNS constant embedded in generateImportHtml — any change
// here must be mirrored there (and vice-versa).
const PROVIDER_KEY_PATTERNS = {
  gemini:    /^AIza[A-Za-z0-9_-]{35}$/,
  groq:      /^gsk_[A-Za-z0-9]{52}$/,
  cerebras:  /^csk-[a-z0-9]{40,}$/,
  ollama:    /^[0-9a-f]{32}\.[A-Za-z0-9]{20,}$/,
  sambanova: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
/** Redact potential API key patterns in upstream error bodies before forwarding to client. */
const _KEY_PATTERNS = /\b(sk-[a-zA-Z0-9_-]{10,}|gsk_[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{30,}|csk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_-]{20,})\b/g;
function _redactKeys(body) {
  if (!body || typeof body !== "string") return body;
  return body.replace(_KEY_PATTERNS, "[REDACTED]");
}

// ── Forward request to upstream provider ────────────────────────────────────
function forward(upstreamBase, key, prov, method, urlPath, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const base = new URL(upstreamBase);
    const url = new URL(base.pathname.replace(/\/+$/, "") + urlPath, base.origin);

    // SSRF / path traversal protection
    const finalPath = url.pathname;
    if (finalPath.includes('\0') || finalPath.includes('..') || decodeURIComponent(finalPath).includes('..')) {
      return reject(new Error('path traversal detected'));
    }
    if (url.hostname !== base.hostname) {
      return reject(new Error('SSRF: hostname mismatch'));
    }

    const FORWARD_REQ_HEADERS = ["content-type", "accept", "user-agent", "x-stainless-lang", "x-stainless-package-version", "x-stainless-os", "x-stainless-arch", "x-stainless-runtime", "x-stainless-runtime-version"];
    const fwdHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (FORWARD_REQ_HEADERS.includes(lk)) fwdHeaders[k] = v;
    }
    fwdHeaders["accept-encoding"] = "identity";

    // Apply auth
    if (prov.authScheme === "bearer") {
      fwdHeaders.authorization = `Bearer ${key}`;
    } else if (prov.authScheme === "header") {
      fwdHeaders[prov.authHeader] = key;
    } else if (prov.authScheme === "query") {
      url.searchParams.set(prov.authQuery || "key", key);
    }

    fwdHeaders.host = url.host;
    if (body && body.length > 0) fwdHeaders["content-length"] = String(body.length);

    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: fwdHeaders,
      timeout: timeoutMs || REQUEST_TIMEOUT,
    }, resolve);
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

// ── Read request body ───────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    req.on("data", chunk => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_SIZE) { req.resume(); done(reject, new Error("body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => done(resolve, Buffer.concat(chunks)));
    req.on("error", (err) => done(reject, err));
  });
}

// ── Parse SSE data lines from a chunk ──────────────────────────────────────
function parseSSELines(str) {
  const results = [];
  const lines = str.includes("data: ") ? str.split("\n").filter(l => l.startsWith("data: ")) : [str];
  for (const line of lines) {
    const json = line.startsWith("data: ") ? line.slice(6) : line;
    if (json === "[DONE]" || !json.trim()) continue;
    try { results.push(JSON.parse(json)); } catch {}
  }
  return results;
}

// Fix #6: Extended list of rate-limit headers to collect (incl. Anthropic, IETF draft)
const RATELIMIT_HEADERS = [
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
  "x-ratelimit-limit-requests-day", "x-ratelimit-remaining-requests-day",
  "x-ratelimit-reset-requests-day",
  "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining",
  "ratelimit-limit", "ratelimit-remaining", "ratelimit-reset",
];

/** Collect all recognized rate-limit headers from a response. */
function collectRateLimitHeaders(upstreamHeaders) {
  const result = {};
  for (const h of RATELIMIT_HEADERS) {
    if (upstreamHeaders[h]) result[h] = upstreamHeaders[h];
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Structured request logging ──────────────────────────────────────────────
const STRUCTURED_LOGS = process.env.FFAI_STRUCTURED_LOGS === "true" || process.env.FFAI_STRUCTURED_LOGS === "1";

function logRequest(reqId, provName, model, statusCode, latencyMs, opts = {}) {
  if (STRUCTURED_LOGS) {
    const entry = {
      ts: new Date().toISOString(),
      reqId,
      provider: provName,
      model: model || undefined,
      status: statusCode,
      latencyMs,
      stream: opts.stream || false,
      retries: opts.retries || 0,
      keyId: opts.keyId || undefined,
    };
    console.log(JSON.stringify(entry));
  }
}

// Smart queue: wait for key availability with soonest-key prediction
const ACQUIRE_WAIT_MS = envInt("FFAI_ACQUIRE_WAIT_MS", 3000);
const ACQUIRE_POLL_MS = 200;

/**
 * Try to acquire a key, waiting up to the provider's acquire budget.
 * Uses soonest-key prediction to decide whether waiting is worthwhile.
 *
 * @returns {{ key, provider }|null} handle, or null with retryAfterMs hint
 */
async function acquireWithWait(provName, opts, res) {
  let handle = pool.acquire(provName, opts);
  if (handle) return handle;

  const waitMs = providerAcquireWait[provName] || ACQUIRE_WAIT_MS;
  if (waitMs <= 0) return null;

  // Check when soonest key will be available
  const prov = pool.getProvider(provName);
  const soonestMs = prov ? prov.soonestAvailableMs() : Infinity;

  // If keys are blocked by cooldown/CB beyond our wait budget, don't bother
  // But if soonest is 0 (keys available but blocked by max_concurrent), always wait
  if (soonestMs > 0 && soonestMs > waitMs) {
    return null;
  }

  const deadline = Date.now() + (soonestMs === 0 ? waitMs : Math.min(waitMs, soonestMs + 500));
  while (Date.now() < deadline) {
    // Bail early if client disconnected — no point acquiring a key nobody's waiting for
    if (res && res.destroyed) return null;
    await new Promise(r => setTimeout(r, ACQUIRE_POLL_MS));
    handle = pool.acquire(provName, opts);
    if (handle) return handle;
  }
  return null;
}

/**
 * Get accurate Retry-After seconds for a provider (for 429 responses).
 * Returns the soonest time any key will be available.
 */
function getRetryAfterSecs(provName) {
  const prov = pool.getProvider(provName);
  if (!prov) return undefined;
  const ms = prov.soonestAvailableMs();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.ceil(ms / 1000);
}

// ── Model → Provider lookup (for auto-routing /v1/* requests) ─────────────
function resolveProviderForModel(modelId) {
  if (!modelId) return null;

  // 1. Check static config models
  for (const name of pool.providerNames()) {
    const pconf = providerConfigs[name];
    if (!pconf) continue;

    // Check model aliases first
    if (pconf.model_aliases && pconf.model_aliases[modelId]) return name;

    // Check models array
    if (Array.isArray(pconf.models) && pconf.models.includes(modelId)) return name;
  }

  // 2. Check discovered models
  const info = discovery.getModelInfo(modelId);
  if (info && info.provider) return info.provider;

  return null;
}

// ── Route: /v1/* — auto-route based on model in request body ───────────────
async function handleAutoRoute(req, res, apiPath, reqId) {
  // Read body to extract model
  let body;
  try { body = await readBody(req); } catch (err) {
    return sendJson(res, 413, { error: err.message });
  }

  let modelId = null;
  try {
    const parsed = JSON.parse(body.toString());
    modelId = parsed.model || null;
  } catch {}

  if (!modelId) {
    return sendJson(res, 400, { error: "missing or invalid 'model' field in request body" });
  }

  const provName = resolveProviderForModel(modelId);
  if (!provName) {
    return sendJson(res, 404, {
      error: "model_not_found",
      message: `No provider found for model "${modelId}". Use /{provider}/v1/... for explicit routing.`,
      model: modelId,
    });
  }

  // Re-create a readable stream from the already-read body so handleProxy can re-read it
  // Instead, we push body back. Simpler: call handleProxy logic directly.
  // We'll create a fake req that yields the already-read body.
  const fakeReq = Object.create(req);
  fakeReq._autoRouteBody = body;
  return handleProxy(fakeReq, res, provName, apiPath, reqId);
}

// ── Route: proxy /{provider}/v1/* ───────────────────────────────────────────
async function handleProxy(req, res, provName, apiPath, reqId) {
  const prov = pool.getProvider(provName);
  if (!prov) return sendJson(res, 404, { error: `unknown provider: ${provName}` });

  const upstream = upstreamUrls[provName];
  if (!upstream) return sendJson(res, 500, { error: `no upstream_url for ${provName}` });

  // Read and optionally sanitize body (reuse pre-read body from auto-route)
  let body;
  if (req._autoRouteBody) {
    body = req._autoRouteBody;
  } else {
    try { body = await readBody(req); } catch (err) {
      return sendJson(res, 413, { error: err.message });
    }
  }

  // Smush: compress messages to reduce input tokens
  if (apiPath.includes("chat/completions") && body.length > 0) {
    const r = smush(body, config);
    body = r.buffer;
    if (r.stats) {
      const costRate = pool._pricing[provName] ?? pool._pricing.default ?? 0;
      // costRate is $ per request; estimate per-token cost assuming ~1000 tokens avg input
      const costPerToken = costRate / 1000;
      pool.stats.recordSmush(provName, r.stats, costPerToken);
    }
  }

  const inputTokens = estimateInputTokens(body);
  const { body: sanitizedBody, modified, parsed: parsedBody } = sanitize(body, { provider: provName });
  const finalBody = modified ? Buffer.from(sanitizedBody) : body;
  const requestModel = parsedBody?.model || null;

  // Inject cached thought signatures for Gemini 3 tool calling
  let forwardBody = finalBody;
  try {
    const parsed = JSON.parse(finalBody.toString());
    if (parsed.messages && prov.injectThoughtSignatures(parsed.messages)) {
      forwardBody = Buffer.from(JSON.stringify(parsed));
    }
  } catch {}

  // Wall 3: Pre-send TPM check — reject upfront if request can't fit any key.
  // This saves a wasted round-trip to upstream that will always 429.
  if (inputTokens > 0 && prov.scorer) {
    const modelLimits = prov.scorer._getModelLimits(requestModel);
    const provTpm = modelLimits.tpm || 0;
    if (provTpm > 0 && inputTokens > provTpm) {
      return sendJson(res, 413, {
        error: "request_too_large",
        message: `Estimated ${inputTokens} tokens exceeds ${provName} TPM limit of ${provTpm}. Use a provider with higher TPM or reduce context size.`,
        provider: provName,
        model: requestModel,
        estimated_tokens: inputTokens,
        tpm_limit: provTpm,
      });
    }
  }

  // Retry loop with key rotation (type-specific retry limits)
  const hardMaxRetries = Math.min(prov.keys.length, 3);
  let lastStatus = 500;
  let dynamicMaxRetries = hardMaxRetries;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= dynamicMaxRetries; attempt++) {
    // Fix #18: wait briefly for key availability instead of instant 429
    const handle = await acquireWithWait(provName, { model: requestModel, inputTokens }, res);
    if (!handle) {
      if (res.destroyed) return; // Client already disconnected during wait
      const retryAfter = getRetryAfterSecs(provName);
      if (retryAfter) res.setHeader("retry-after", String(retryAfter));
      return sendJson(res, 429, { error: "All keys rate limited", provider: provName, retry_after: retryAfter || null });
    }

    const { key } = handle;

    // Pre-flight capacity check: warn if key is near limits (helps callers throttle)
    const preflight = prov.preflightCheck(key, requestModel, inputTokens);
    if (preflight && !preflight.ok) {
      res.setHeader("x-ffai-capacity-warning", "low");
    }

    try {
      const upstream_res = await forward(upstream, key, prov, req.method, apiPath, req.headers, forwardBody, providerTimeouts[provName]);
      lastStatus = upstream_res.statusCode;

      // Exception-type retry policy: different errors get different retry counts
      const typeMaxRetries = Math.min(prov.maxRetriesFor(lastStatus), hardMaxRetries);
      dynamicMaxRetries = Math.min(dynamicMaxRetries, typeMaxRetries);

      if (prov.isRetryable(lastStatus) && attempt < dynamicMaxRetries) {
        // Read 429 body for provider-specific parsing (before draining)
        let errorBody = "";
        if (lastStatus === 429) {
          errorBody = await new Promise(r => {
            let buf = ""; upstream_res.on("data", c => { if (buf.length < 4096) buf += c; });
            upstream_res.on("end", () => r(buf)); upstream_res.on("error", () => r(buf));
          });
        } else {
          upstream_res.resume();
        }
        const retryAfter = upstream_res.headers["retry-after"] || upstream_res.headers["retry-after-ms"];
        const errorContext = lastStatus === 429 ? parse429(provName, errorBody, upstream_res.headers) : undefined;
        const latencyMs = Date.now() - startTime;
        pool.release(provName, key, { success: false, statusCode: lastStatus, retryAfter, inputTokens, latencyMs, model: requestModel, errorContext });
        // Instant retry if other healthy keys exist; backoff only when pool is stressed
        const status = prov.keyStatus();
        if (status.available <= 1) {
          const delay = Math.min(100 * Math.pow(2, attempt), 2000);
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }

      // ── Deprecation detection for 400/404 ──────────────────────────────────
      if ((lastStatus === 404 || lastStatus === 400) && requestModel) {
        const depBody = await new Promise(r => {
          let buf = ""; upstream_res.on("data", c => { if (buf.length < 4096) buf += c; });
          upstream_res.on("end", () => r(buf)); upstream_res.on("error", () => r(buf));
        });
        // Log error details for debugging
        const bodyKeys = parsedBody ? Object.keys(parsedBody).join(",") : "unparsed";
        console.warn(`[ffai:${provName}] ${lastStatus} for model=${requestModel} bodyKeys=[${bodyKeys}] errBody=${(depBody || "(empty)").slice(0, 500)}`);
        if (deprecationTracker.check(lastStatus, depBody, requestModel, provName)) {
          // Deprecated model — release as neutral (not key error), don't retry
          const latencyMs = Date.now() - startTime;
          pool.release(provName, key, { success: true, statusCode: lastStatus, inputTokens, latencyMs, model: requestModel });
          const depHeaders = { "content-type": "application/json", "x-ffai-provider": provName, "x-ffai-request-id": reqId, "x-ffai-deprecated": "true", "x-ffai-latency-ms": String(latencyMs) };
          res.writeHead(lastStatus, depHeaders);
          res.end(_redactKeys(depBody));
          return;
        }
        // Not deprecated — send the already-read body as the response (redact potential key leaks)
        const respHeaders = { "x-ffai-provider": provName, "x-ffai-request-id": reqId, "x-ffai-latency-ms": String(Date.now() - startTime) };
        for (const [k, v] of Object.entries(upstream_res.headers)) {
          const lk = k.toLowerCase();
          if (lk === "content-type") respHeaders[k] = v;
        }
        const latencyMs = Date.now() - startTime;
        pool.release(provName, key, { success: false, statusCode: lastStatus, inputTokens, latencyMs, model: requestModel });
        res.writeHead(lastStatus, respHeaders);
        res.end(_redactKeys(depBody));
        return;
      }

      // Stream response back
      const FORWARD_RESP_HEADERS = ["content-type", "content-length", "transfer-encoding", "retry-after", "retry-after-ms", "x-request-id", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "openai-processing-ms", "openai-model", "cache-control", "vary"];
      const respHeaders = {};
      for (const [k, v] of Object.entries(upstream_res.headers)) {
        if (FORWARD_RESP_HEADERS.includes(k.toLowerCase())) {
          respHeaders[k] = v;
        }
      }
      if (modified) respHeaders["x-ffai-modified"] = "true";
      respHeaders["x-ffai-provider"] = provName;
      respHeaders["x-ffai-request-id"] = reqId;
      respHeaders["x-ffai-latency-ms"] = String(Date.now() - startTime);

      // Utilization pressure header — callers can throttle when system is hot
      const util = pool.utilization(provName, requestModel);
      if (util != null) respHeaders["x-ffai-utilization"] = util.toFixed(2);

      res.writeHead(upstream_res.statusCode, respHeaders);

      // ── SSE-aware response streaming ──────────────────────────────────────
      const isSSE = (upstream_res.headers["content-type"] || "").includes("text/event-stream");

      if (isSSE) {
        // Fix #15: track active stream in scorer
        if (prov.scorer) prov.scorer.startStream(key);

        // Track for graceful shutdown
        activeSSEConnections.add(res);
        res.on("close", () => activeSSEConnections.delete(res));

        const streamTimeout = SSE_TIMEOUT > 0 ? SSE_TIMEOUT : Math.max(REQUEST_TIMEOUT * 3, 360000);
        let sseTimedOut = false;
        const sseTimer = setTimeout(() => {
          sseTimedOut = true;
          console.error(`[ffai:${reqId}] SSE stream timeout (${streamTimeout / 1000}s) — destroying upstream`);
          upstream_res.destroy();
          if (!res.writableEnded) { try { res.write("data: [DONE]\n\n"); } catch {} res.end(); }
        }, streamTimeout);

        let pendingSSE = "";
        let released = false; // Fix #1: single-release guard
        let ttftMs = null; // Time to first token (first data chunk)

        upstream_res.on("data", (chunk) => {
          if (ttftMs === null) ttftMs = Date.now() - startTime;
          if (!sseTimedOut && !res.writableEnded && !res.destroyed) {
            const ok = res.write(chunk);
            if (!ok) { upstream_res.pause(); res.once("drain", () => upstream_res.resume()); }
          }
          const str = chunk.toString();

          // Fix #4: cap pendingSSE buffer at 256KB
          pendingSSE += str;
          if (pendingSSE.length > 262144) {
            // Keep only the tail — we only need it for cross-chunk boundary parsing
            pendingSSE = pendingSSE.slice(-8192);
          }
          const parts = pendingSSE.split("\n\n");
          pendingSSE = parts.pop() || "";
          for (const part of parts) {
            if (!part.trim()) continue;
            if (part.includes('"tool_calls"') || part.includes('"thought_signature"')) {
              for (const parsed of parseSSELines(part)) {
                prov.extractThoughtSignatures(parsed);
              }
            }
            // Fix #3: collect rate-limit headers on SSE usage extraction too
            if (prov.scorer && !released && part.includes('"usage"')) {
              for (const parsed of parseSSELines(part)) {
                if (parsed?.usage) {
                  const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                  if (outTokens > 0) {
                    const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
                    pool.release(provName, key, { success: true, statusCode: upstream_res.statusCode, outputTokens: outTokens, inputTokens, latencyMs: Date.now() - startTime, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
                    released = true;
                    if (prov.scorer) prov.scorer.endStream(key); // Fix #15
                    // Feature 5: capability auto-detection
                    if (requestModel) {
                      capabilities.ingestFromResponse(requestModel, provName, { streaming: true });
                      if (prov.scorer) {
                        capabilities.ingestFromHeaders(requestModel, provName, { rpm: prov.scorer.learnedRpm.get(key), tpm: prov.scorer.learnedTpm.get(key), rpd: prov.scorer.learnedRpd.get(key) });
                      }
                    }
                  }
                }
              }
            }
          }
        });

        upstream_res.on("end", () => {
          clearTimeout(sseTimer);
          activeSSEConnections.delete(res);
          if (pendingSSE.trim()) {
            for (const parsed of parseSSELines(pendingSSE)) {
              prov.extractThoughtSignatures(parsed);
              if (prov.scorer && !released && parsed?.usage) {
                const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                if (outTokens > 0) {
                  const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
                  pool.release(provName, key, { success: true, statusCode: upstream_res.statusCode, outputTokens: outTokens, inputTokens, latencyMs: Date.now() - startTime, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
                  released = true;
                  if (prov.scorer) prov.scorer.endStream(key);
                  // Feature 5: capability auto-detection (SSE end parse)
                  if (requestModel) {
                    capabilities.ingestFromResponse(requestModel, provName, { streaming: true });
                    if (prov.scorer) {
                      capabilities.ingestFromHeaders(requestModel, provName, { rpm: prov.scorer.learnedRpm.get(key), tpm: prov.scorer.learnedTpm.get(key), rpd: prov.scorer.learnedRpd.get(key) });
                    }
                  }
                }
              }
            }
          }
          if (!res.writableEnded) res.end();
          // Release if usage wasn't extracted from SSE chunks
          if (!released) {
            const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
            const latencyMs = Date.now() - startTime;
            const success = upstream_res.statusCode < 400;
            pool.release(provName, key, { success, statusCode: upstream_res.statusCode, inputTokens, retryAfter: upstream_res.headers["retry-after"], latencyMs, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
            if (prov.scorer) prov.scorer.endStream(key);
            // Feature 5: capability auto-detection (SSE fallback release)
            if (requestModel && success) {
              capabilities.ingestFromResponse(requestModel, provName, { streaming: true });
              if (prov.scorer) {
                capabilities.ingestFromHeaders(requestModel, provName, { rpm: prov.scorer.learnedRpm.get(key), tpm: prov.scorer.learnedTpm.get(key), rpd: prov.scorer.learnedRpd.get(key) });
              }
            }
          }
          logRequest(reqId, provName, requestModel, upstream_res.statusCode, Date.now() - startTime, { stream: true, retries: attempt, keyId: prov.keyId(key) });
        });

        // Fix #1: error handler checks released flag to prevent double-release
        upstream_res.on("error", (err) => {
          clearTimeout(sseTimer);
          activeSSEConnections.delete(res);
          console.error(`[ffai:${reqId}] SSE stream error: ${err.message}`);
          res.destroy();
          if (!released) {
            pool.release(provName, key, { success: false, statusCode: 0, inputTokens, latencyMs: Date.now() - startTime, model: requestModel });
            released = true;
          }
          if (prov.scorer) prov.scorer.endStream(key);
        });
        res.on("close", () => {
          clearTimeout(sseTimer);
          if (!upstream_res.destroyed) upstream_res.destroy();
        });
      } else {
        // Non-streaming: intercept to extract usage tokens + rate limit headers
        let respBody = "";
        let released = false; // Fix #1: guard for non-streaming too

        upstream_res.on("data", (chunk) => {
          if (!res.writableEnded && !res.destroyed) {
            const ok = res.write(chunk);
            if (!ok) { upstream_res.pause(); res.once("drain", () => upstream_res.resume()); }
          }
          if (respBody.length < 65536) respBody += chunk.toString();
        });

        upstream_res.on("error", (err) => {
          console.error(`[ffai:${reqId}] upstream stream error: ${err.message}`);
          res.destroy();
          if (!released) {
            pool.release(provName, key, { success: false, statusCode: 0, inputTokens, latencyMs: Date.now() - startTime, model: requestModel });
            released = true;
          }
        });
        res.on("close", () => {
          if (!upstream_res.destroyed) upstream_res.destroy();
        });

        upstream_res.on("end", () => {
          if (!res.writableEnded) res.end();
          if (released) return; // Fix #1
          released = true;
          const latencyMs = Date.now() - startTime;
          const success = upstream_res.statusCode < 400;

          let outputTokens = 0;
          try {
            const parsed = JSON.parse(respBody);
            if (parsed?.usage) {
              outputTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
            }
            prov.extractThoughtSignatures(parsed);
          } catch {}

          const rlHeaders = collectRateLimitHeaders(upstream_res.headers);

          pool.release(provName, key, {
            success,
            statusCode: upstream_res.statusCode,
            inputTokens,
            outputTokens,
            retryAfter: upstream_res.headers["retry-after"] || upstream_res.headers["retry-after-ms"],
            latencyMs,
            model: requestModel,
            rateLimitHeaders: rlHeaders,
          });

          // Feature 5: capability auto-detection (non-streaming)
          if (requestModel && success) {
            capabilities.ingestFromResponse(requestModel, provName, { streaming: false });
            if (prov.scorer) {
              capabilities.ingestFromHeaders(requestModel, provName, { rpm: prov.scorer.learnedRpm.get(key), tpm: prov.scorer.learnedTpm.get(key), rpd: prov.scorer.learnedRpd.get(key) });
            }
          }
          logRequest(reqId, provName, requestModel, upstream_res.statusCode, latencyMs, { stream: false, retries: attempt, keyId: prov.keyId(key) });
        });
      }
      return;

    } catch (err) {
      const latencyMs = Date.now() - startTime;
      pool.release(provName, key, { success: false, statusCode: 0, inputTokens, latencyMs, model: requestModel });
      // Network/timeout errors: statusCode 0
      dynamicMaxRetries = Math.min(dynamicMaxRetries, prov.maxRetriesFor(0));
      if (attempt >= dynamicMaxRetries) {
        return sendJson(res, 502, { error: "upstream error", provider: provName });
      }
      // Instant retry if healthy keys available; backoff only when stressed
      const status = prov.keyStatus();
      if (status.available <= 1) {
        await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 2000)));
      }
    }
  }

  sendJson(res, lastStatus, { error: "all retries exhausted", provider: provName });
}

// ── Key Import: encrypted batch import system ──────────────────────────────
// Tokens are stored in config.json under "import_tokens": [{ id, token, created }]
// The HTML page encrypts keys client-side with AES-256-GCM (PBKDF2-derived key from token).
// The /import endpoint decrypts, validates, and writes keys into provider config.

function generateImportHtml(pubRawB64, createdAtMs) {
  // The server's ECDH P-256 public key is baked in. It contains NO decryption
  // secret — an attacker who captures this HTML plus the encrypted blob still
  // cannot recover the keys, because decryption requires the server's private
  // key (which never leaves this host).
  //
  // `createdAtMs` is the ms-since-epoch when the page was issued; the page
  // shows a live countdown and refuses to encrypt past expiry to match the
  // server's TTL gate.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src *">
<meta name="referrer" content="no-referrer">
<title>FFAI — Import Keys</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
         background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 700px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 0.5rem; font-size: 1.5rem; }
  .subtitle { color: #8b949e; margin-bottom: 1.5rem; font-size: 0.9rem; }
  label { display: block; font-weight: 600; margin-bottom: 0.3rem; color: #c9d1d9; }
  select, textarea, input { width: 100%; background: #161b22; border: 1px solid #30363d;
    color: #c9d1d9; border-radius: 6px; padding: 0.6rem; font-family: inherit; font-size: 0.9rem; }
  select:focus, textarea:focus, input:focus { outline: none; border-color: #58a6ff; }
  textarea { min-height: 180px; resize: vertical; }
  .row { margin-bottom: 1rem; }
  button { background: #238636; color: #fff; border: none; border-radius: 6px;
    padding: 0.7rem 1.5rem; font-size: 1rem; cursor: pointer; font-weight: 600; }
  button:hover { background: #2ea043; }
  button:disabled { background: #21262d; color: #484f58; cursor: not-allowed; }
  .output { margin-top: 1.5rem; }
  .output textarea { background: #0d1117; color: #7ee787; font-size: 0.85rem; min-height: 120px; }
  .status { margin-top: 0.5rem; font-size: 0.85rem; }
  .status.ok { color: #7ee787; }
  .status.err { color: #f85149; }
  .info { background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 0.8rem; margin-bottom: 1.5rem; font-size: 0.85rem; color: #8b949e; }
  .copy-btn { background: #30363d; font-size: 0.8rem; padding: 0.4rem 0.8rem; margin-top: 0.5rem; }
  .copy-btn:hover { background: #484f58; }
</style>
</head>
<body>
<h1>FFAI — Import Keys</h1>
<p class="subtitle">Encrypt API keys locally in your browser using public-key crypto.</p>
<div class="info">
  &#x1f512; Keys are encrypted to the FFAI server's public key (ECDH P-256 + AES-256-GCM).
  Only the FFAI server holds the private half — an attacker who captures both this
  page AND the encrypted blob still cannot decrypt the keys.
  <br><br>&#x23f3; Page expires in <span id="countdown" style="color:#58a6ff;font-weight:600;">—</span>.
  After expiry the blob will be rejected by the server.
</div>

<div class="row">
  <label for="provider">Provider</label>
  <select id="provider">
    <option value="auto">Auto-detect (recommended)</option>
    <option value="gemini">Gemini</option>
    <option value="groq">Groq</option>
    <option value="cerebras">Cerebras</option>
    <option value="ollama">Ollama</option>
    <option value="sambanova">SambaNova</option>
  </select>
</div>

<div class="row">
  <label for="keys">API Keys (one per line)</label>
  <textarea id="keys" autocomplete="off" placeholder="AIzaSy...&#10;AIzaSy...&#10;AIzaSy..."></textarea>
  <div class="status" id="detect-status" style="margin-top:0.4rem;"></div>
</div>

<div class="row">
  <label for="ffai-url">FFAI Server URL (optional — for direct import)</label>
  <input id="ffai-url" type="url" autocomplete="off" placeholder="http://your-server:8010" />
</div>

<button id="encrypt-btn" onclick="doEncrypt()">Encrypt Keys</button>
<button id="send-btn" onclick="doSend()" style="display:none;margin-left:0.5rem;">Send to FFAI</button>

<div class="output" id="output-section" style="display:none;">
  <label>Encrypted Payload</label>
  <textarea id="payload" readonly></textarea>
  <button class="copy-btn" onclick="doCopy()">Copy to Clipboard</button>
  <div class="status" id="status"></div>
</div>

<script>
// Server's ECDH P-256 public key, uncompressed SEC1 form (65 bytes: 0x04 || X || Y)
// baked in at page generation. Contains no secret material.
const SERVER_PUB_B64 = ${JSON.stringify(pubRawB64)};
const ISSUED_AT = ${createdAtMs};
const TTL_MS = ${IMPORT_TOKEN_TTL_MS};

// Key-format patterns — kept in sync with KEY_PATTERNS on the server side.
// Order matters: more-specific prefixes (gsk_, csk-, AIza) are checked before
// the bare-UUID / hex-dot patterns that would otherwise over-match.
const KEY_PATTERNS = [
  { provider: "gemini",    regex: /^AIza[A-Za-z0-9_-]{35}$/ },
  { provider: "groq",      regex: /^gsk_[A-Za-z0-9]{52}$/ },
  { provider: "cerebras",  regex: /^csk-[a-z0-9]{40,}$/ },
  { provider: "ollama",    regex: /^[0-9a-f]{32}\\.[A-Za-z0-9]{20,}$/ },
  { provider: "sambanova", regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
];

function detectProvider(key) {
  for (const { provider, regex } of KEY_PATTERNS) {
    if (regex.test(key)) return provider;
  }
  return null;
}

function arrToBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function msRemaining() { return (ISSUED_AT + TTL_MS) - Date.now(); }

function fmtDuration(ms) {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + "h " + m + "m";
  return m + ":" + String(sec).padStart(2, "0");
}

// Derive a symmetric AES-256-GCM key by ECDH with the server's public key,
// piped through HKDF-SHA256. Returns { aesKey, ephPubRaw } — the caller must
// send ephPubRaw alongside the ciphertext so the server can redo the ECDH.
async function deriveSharedAesKey() {
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const serverPub = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(SERVER_PUB_B64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverPub },
    eph.privateKey,
    256
  );
  const ikm = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const aesKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode("ffai-import-v2") },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  return { aesKey, ephPubRaw };
}

async function doEncrypt() {
  const btn = document.getElementById("encrypt-btn");
  const status = document.getElementById("status");
  const keysRaw = document.getElementById("keys").value.trim();
  const providerSelection = document.getElementById("provider").value;

  if (!keysRaw) { status.textContent = "No keys entered."; status.className = "status err"; return; }

  const keys = [...new Set(keysRaw.split("\\n").map(k => k.trim()).filter(Boolean))];
  if (keys.length === 0) { status.textContent = "No valid keys found."; status.className = "status err"; return; }

  const dupes = keysRaw.split("\\n").map(k => k.trim()).filter(Boolean).length - keys.length;

  // Resolve provider: auto-detect, or validate that user's explicit pick
  // matches every key. Mixed batches are rejected — a single payload carries
  // one provider label; mislabeled keys would land in the wrong pool.
  const detected = keys.map(detectProvider);
  const uniqueDetected = [...new Set(detected.filter(Boolean))];
  let provider;
  if (providerSelection === "auto") {
    if (uniqueDetected.length === 0) {
      status.textContent = "Could not auto-detect provider for any key. Pick a provider manually.";
      status.className = "status err";
      return;
    }
    if (uniqueDetected.length > 1) {
      status.textContent = "Keys appear to belong to different providers (" + uniqueDetected.join(", ") + "). Encrypt them in separate batches.";
      status.className = "status err";
      return;
    }
    const unrecognized = detected.filter(d => !d).length;
    if (unrecognized > 0) {
      status.textContent = unrecognized + " key(s) did not match any known provider format.";
      status.className = "status err";
      return;
    }
    provider = uniqueDetected[0];
  } else {
    provider = providerSelection;
    const wrong = [];
    for (let i = 0; i < keys.length; i++) {
      if (detected[i] && detected[i] !== provider) wrong.push(i + 1);
      else if (!detected[i]) wrong.push(i + 1);
    }
    if (wrong.length > 0) {
      status.textContent = "Key(s) on line " + wrong.join(", ") + " do not match the " + provider + " format. Use Auto-detect or fix the keys.";
      status.className = "status err";
      return;
    }
  }

  if (msRemaining() <= 0) {
    status.textContent = "This page has expired. Generate a new one via /ffai_encrypt.";
    status.className = "status err";
    return;
  }

  btn.disabled = true;
  btn.textContent = "Encrypting...";

  try {
    const { aesKey, ephPubRaw } = await deriveSharedAesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // Nonce inside the plaintext gives the server a stable anti-replay token —
    // even though the ciphertext already contains a unique ephemeral pubkey,
    // the nonce is what gets remembered on the server for the TTL window.
    const nonce = arrToBase64(crypto.getRandomValues(new Uint8Array(18)));
    const plaintext = JSON.stringify({ provider, keys, ts: Date.now(), nonce });

    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, enc.encode(plaintext));

    const payload = {
      v: 2,
      ephPub: arrToBase64(ephPubRaw),
      iv: arrToBase64(iv),
      ct: arrToBase64(new Uint8Array(ciphertext))
    };

    const blob = "FFAI-IMPORT:" + btoa(JSON.stringify(payload));
    document.getElementById("payload").value = blob;
    document.getElementById("output-section").style.display = "block";
    document.getElementById("send-btn").style.display = document.getElementById("ffai-url").value ? "inline-block" : "none";

    const msg = keys.length + " key(s) encrypted" + (dupes > 0 ? " (" + dupes + " duplicate(s) removed)" : "") + ".";
    status.textContent = msg;
    status.className = "status ok";
  } catch (err) {
    status.textContent = "Encryption failed: " + err.message;
    status.className = "status err";
  } finally {
    btn.disabled = false;
    btn.textContent = "Encrypt Keys";
  }
}

async function doSend() {
  const status = document.getElementById("status");
  const url = document.getElementById("ffai-url").value.trim().replace(/\\/+$/, "");
  const blob = document.getElementById("payload").value;
  if (!url || !blob) return;

  status.textContent = "Sending...";
  status.className = "status";
  try {
    const resp = await fetch(url + "/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: blob })
    });
    const data = await resp.json();
    if (resp.ok) {
      status.textContent = "Imported " + (data.imported || 0) + " key(s)." +
        (data.duplicates ? " " + data.duplicates + " duplicate(s) skipped." : "") +
        (data.invalid ? " " + data.invalid + " invalid." : "");
      status.className = "status ok";
    } else {
      status.textContent = "Server error: " + (data.error || resp.status);
      status.className = "status err";
    }
  } catch (err) {
    status.textContent = "Network error: " + err.message;
    status.className = "status err";
  }
}

function doCopy() {
  const ta = document.getElementById("payload");
  ta.select();
  navigator.clipboard.writeText(ta.value).then(() => {
    document.getElementById("status").textContent = "Copied to clipboard!";
    document.getElementById("status").className = "status ok";
  });
}

// Show/hide send button based on URL field
document.getElementById("ffai-url").addEventListener("input", () => {
  const hasUrl = document.getElementById("ffai-url").value.trim().length > 0;
  const hasPayload = document.getElementById("payload") && document.getElementById("payload").value;
  document.getElementById("send-btn").style.display = (hasUrl && hasPayload) ? "inline-block" : "none";
});

// Live detection hint as user types — helps catch mislabeled pastes before encrypt.
function updateDetectHint() {
  const el = document.getElementById("detect-status");
  const raw = document.getElementById("keys").value.trim();
  if (!raw) { el.textContent = ""; el.className = "status"; return; }
  const keys = raw.split("\\n").map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) { el.textContent = ""; el.className = "status"; return; }
  const detected = keys.map(detectProvider);
  const unique = [...new Set(detected.filter(Boolean))];
  const unknown = detected.filter(d => !d).length;
  if (unique.length === 1 && unknown === 0) {
    el.textContent = "Detected: " + unique[0] + " (" + keys.length + " key" + (keys.length === 1 ? "" : "s") + ")";
    el.className = "status ok";
  } else if (unique.length > 1) {
    el.textContent = "Mixed providers detected: " + unique.join(", ") + ". Split into separate batches.";
    el.className = "status err";
  } else if (unknown > 0) {
    el.textContent = unknown + " key(s) did not match any known format.";
    el.className = "status err";
  }
}
document.getElementById("keys").addEventListener("input", updateDetectHint);

// Live TTL countdown — refreshes once per second. When the window closes we
// disable the encrypt button and surface a hard error, so the user is never
// tricked into producing a blob the server will reject.
function refreshCountdown() {
  const el = document.getElementById("countdown");
  const btn = document.getElementById("encrypt-btn");
  const remaining = msRemaining();
  if (remaining <= 0) {
    el.textContent = "EXPIRED";
    el.style.color = "#f85149";
    btn.disabled = true;
    btn.textContent = "Page expired";
  } else {
    el.textContent = fmtDuration(remaining);
    // Colour shift in the last 60 seconds to cue urgency
    el.style.color = remaining < 60000 ? "#f85149" : "#58a6ff";
  }
}
refreshCountdown();
setInterval(refreshCountdown, 1000);
</script>
</body>
</html>`;
}

// ── Route: /generate-import ──────────────────────────────────────────────────
function handleGenerateImport(req, res) {
  // v2 flow: no per-request token to persist. Every page embeds the same
  // long-lived server public key plus the current timestamp. Replay protection
  // lives server-side in the _importNonces map, and temporal scoping is the
  // TTL check below in handleImport.
  if (!_importKeypair || !_importKeypair.publicRawB64) {
    return sendJson(res, 503, { error: "import keypair not initialised" });
  }

  const createdAtMs = Date.now();
  const html = generateImportHtml(_importKeypair.publicRawB64, createdAtMs);
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-disposition": "attachment; filename=\"ffai_encrypt.html\"",
    "content-length": String(Buffer.byteLength(html, "utf8")),
  });
  res.end(html);
  console.log(`[ffai] Generated v2 import page (issued at ${new Date(createdAtMs).toISOString()})`);
}

// ── Route: /import ──────────────────────────────────────────────────────────
async function handleImport(req, res) {
  // Fix #5: Rate limit import attempts per IP
  const ip = req.socket?.remoteAddress || "unknown";
  if (!checkImportRateLimit(ip)) {
    auditLog({ event: "import_rate_limited", ip });
    return sendJson(res, 429, { error: "too many import attempts — try again later" });
  }

  let body;
  try { body = await readBody(req); } catch (err) {
    return sendJson(res, 400, { error: "bad request" });
  }

  let parsed;
  try { parsed = JSON.parse(body.toString("utf8")); } catch {
    return sendJson(res, 400, { error: "invalid JSON" });
  }

  let blob = parsed.payload;
  if (!blob || typeof blob !== "string") return sendJson(res, 400, { error: "missing payload field" });

  // Strip FFAI-IMPORT: prefix
  if (blob.startsWith("FFAI-IMPORT:")) blob = blob.slice(12);

  let envelope;
  try { envelope = JSON.parse(Buffer.from(blob, "base64").toString("utf8")); } catch {
    return sendJson(res, 400, { error: "invalid payload encoding" });
  }

  // Dispatch on envelope version. v2 is the public-key ECDH flow; v1 is the
  // legacy shared-secret flow, retained so blobs encrypted against an HTML
  // page issued before the upgrade can still be imported within their 24h
  // window. Both paths produce the same `plaintext` / `auditContext` shape
  // so the downstream write logic is shared.
  let plaintext;
  let auditContext;
  if (envelope.v === 2) {
    const result = await v2Decrypt(envelope, ip);
    if (result.error) return sendJson(res, result.status || 403, { error: result.error });
    plaintext = result.plaintext;
    auditContext = { version: 2, tokenId: null };
  } else if (envelope.v === 1) {
    const result = v1Decrypt(envelope, ip);
    if (result.error) return sendJson(res, result.status || 403, { error: result.error });
    plaintext = result.plaintext;
    auditContext = { version: 1, tokenId: result.tokenId, matchId: result.matchId };
  } else {
    return sendJson(res, 400, { error: "unsupported payload version" });
  }

  let data;
  try { data = JSON.parse(plaintext); } catch {
    return sendJson(res, 400, { error: "decrypted payload is not valid JSON" });
  }

  // v2 replay protection: the decrypted plaintext carries a random nonce; the
  // server remembers it for IMPORT_NONCE_TTL_MS and rejects re-uses. For v1
  // the single-use token already prevents replay, so skip.
  if (auditContext.version === 2) {
    if (typeof data.nonce !== "string" || data.nonce.length < 16) {
      auditLog({ event: "import_failed", reason: "missing_nonce", ip });
      authGuard.recordFailure(ip);
      return sendJson(res, 400, { error: "payload missing nonce" });
    }
    if (!rememberImportNonce(data.nonce)) {
      auditLog({ event: "import_failed", reason: "replay", ip });
      authGuard.recordFailure(ip);
      return sendJson(res, 403, { error: "import failed — this blob was already used" });
    }
    // Temporal window: reject blobs encrypted too far in the past.
    const ageMs = typeof data.ts === "number" ? Date.now() - data.ts : Infinity;
    if (!Number.isFinite(ageMs) || ageMs > IMPORT_TOKEN_TTL_MS || ageMs < -60_000) {
      auditLog({ event: "import_failed", reason: "stale_blob", ageMs, ip });
      authGuard.recordFailure(ip);
      return sendJson(res, 403, { error: "import failed — blob has expired" });
    }
  }

  const { provider, keys } = data;
  if (!provider || !Array.isArray(keys) || keys.length === 0) {
    return sendJson(res, 400, { error: "payload must contain provider and keys[]" });
  }

  // Read current config
  const currentConfig = tryLoadConfig();
  if (!currentConfig) return sendJson(res, 500, { error: "failed to read config" });

  if (!currentConfig.providers || !currentConfig.providers[provider]) {
    return sendJson(res, 400, { error: `unknown provider: "${provider}"` });
  }

  const provConf = currentConfig.providers[provider];

  // Determine existing keys for this provider
  let existingKeys = [];
  if (Array.isArray(provConf.keys)) {
    existingKeys = provConf.keys;
  } else if (provConf.keys_var) {
    existingKeys = (process.env[provConf.keys_var] || "").split(",").map(k => k.trim()).filter(Boolean);
  }

  // Deduplicate and validate
  const existingSet = new Set(existingKeys);
  const providerPattern = PROVIDER_KEY_PATTERNS[provider];
  let imported = 0;
  let duplicates = 0;
  let invalid = 0;
  let mismatched = 0;
  const newKeys = [];

  for (const key of keys) {
    if (typeof key !== "string" || key.trim().length < 8) { invalid++; continue; }
    const trimmed = key.trim();
    // Format check: if we know the provider's fingerprint, reject keys that
    // don't match. A Groq key in the Gemini pool would 401 on every rotation
    // until the circuit breaker trips. Unknown providers (no pattern
    // registered) fall through to the old length-only check above.
    if (providerPattern && !providerPattern.test(trimmed)) { mismatched++; continue; }
    if (existingSet.has(trimmed)) { duplicates++; continue; }
    existingSet.add(trimmed);
    newKeys.push(trimmed);
    imported++;
  }

  // Token consumption is a v1-only concern — v2 uses the nonce map instead
  // of per-token state in config.json.
  const consumeV1Token = () => {
    if (auditContext.version === 1 && auditContext.matchId) {
      _consumeImportToken(currentConfig, auditContext.matchId);
    }
  };

  if (imported === 0) {
    consumeV1Token();
    auditLog({
      event: "import_empty",
      v: auditContext.version,
      tokenId: auditContext.matchId ?? null,
      provider, duplicates, invalid, mismatched, ip,
    });
    const msg = mismatched > 0
      ? `no keys imported — ${mismatched} key(s) did not match the ${provider} format`
      : "no new keys to import";
    return sendJson(res, 200, { imported: 0, duplicates, invalid, mismatched, provider, message: msg });
  }

  // Write keys into config
  if (!Array.isArray(provConf.keys)) provConf.keys = [...existingKeys];
  provConf.keys.push(...newKeys);

  consumeV1Token();

  // Fix #6: Atomic config write
  try {
    writeConfigAtomic(currentConfig);
  } catch (err) {
    console.error(`[ffai] Failed to save imported keys: ${err.message}`);
    return sendJson(res, 500, { error: "failed to save keys" });
  }

  // Fix #16: Audit log
  auditLog({
    event: "import_success",
    v: auditContext.version,
    tokenId: auditContext.matchId ?? null,
    provider,
    imported,
    duplicates,
    invalid,
    mismatched,
    ip,
  });

  // Trigger hot-reload so the pool picks up the new keys
  console.log(`[ffai] Import v${auditContext.version}: ${imported} key(s) added to "${provider}" (${duplicates} dupes, ${invalid} invalid, ${mismatched} mismatched)`);
  process.kill(process.pid, "SIGHUP");

  sendJson(res, 200, { imported, duplicates, invalid, mismatched, provider });
}

// Fix #1: Helper to remove a used token from config
function _consumeImportToken(currentConfig, tokenId) {
  if (!Array.isArray(currentConfig.import_tokens)) return;
  currentConfig.import_tokens = currentConfig.import_tokens.filter(t => t.id !== tokenId);
  config.import_tokens = currentConfig.import_tokens;
}

// ── v1 (legacy shared-secret) decrypt ───────────────────────────────────────
// Retained only so HTML pages generated before the v2 upgrade can still be
// used within their 24h TTL. New pages always emit v2 blobs.
function v1Decrypt(envelope, ip) {
  const tokens = config.import_tokens || [];
  const match = tokens.find(t => t.id === envelope.id);
  const matchAge = match ? Date.now() - new Date(match.created).getTime() : null;
  const validMatch = match && matchAge <= IMPORT_TOKEN_TTL_MS;

  if (!validMatch) {
    const reason = match ? "expired_token" : "unknown_token";
    auditLog({ event: "import_failed", v: 1, reason, tokenId: envelope.id, ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — token invalid, expired, or already used", status: 403 };
  }

  try {
    const salt = Buffer.from(envelope.salt, "base64");
    const iv = Buffer.from(envelope.iv, "base64");
    const ct = Buffer.from(envelope.ct, "base64");

    const keyMaterial = crypto.pbkdf2Sync(match.token, salt, 600000, 32, "sha256");
    const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial, iv);

    const authTag = ct.slice(ct.length - 16);
    const encrypted = ct.slice(0, ct.length - 16);
    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return { plaintext, tokenId: envelope.id, matchId: match.id };
  } catch (err) {
    console.warn(`[ffai] v1 decrypt failed (token ${envelope.id}): ${err.message}`);
    auditLog({ event: "import_failed", v: 1, reason: "decrypt_failed", tokenId: envelope.id, ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — token invalid, expired, or already used", status: 403 };
  }
}

// ── v2 (public-key ECDH) decrypt ────────────────────────────────────────────
// The envelope carries the browser's ephemeral P-256 public key (`ephPub`).
// We perform ECDH with our persistent private key, pipe the shared bits
// through HKDF-SHA256 with the same "ffai-import-v2" info string the browser
// used, and AES-GCM decrypt. Any mismatch (tampered ct, wrong pubkey, replay
// of a random blob) surfaces as "decrypt_failed" — the generic error message
// we return externally avoids leaking which specific validation tripped.
async function v2Decrypt(envelope, ip) {
  if (!_importKeypair || !_importKeypair.privateKeyObj) {
    auditLog({ event: "import_failed", v: 2, reason: "no_keypair", ip });
    return { error: "server misconfigured: no import keypair", status: 503 };
  }

  let ephPubRaw, iv, ct;
  try {
    ephPubRaw = Buffer.from(envelope.ephPub, "base64");
    iv = Buffer.from(envelope.iv, "base64");
    ct = Buffer.from(envelope.ct, "base64");
  } catch {
    return { error: "invalid payload fields", status: 400 };
  }

  // P-256 uncompressed raw pubkey is always 65 bytes (0x04 || X(32) || Y(32)).
  // Reject anything else early instead of letting createPublicKey surface a
  // cryptic error to the client.
  if (ephPubRaw.length !== 65 || ephPubRaw[0] !== 0x04) {
    auditLog({ event: "import_failed", v: 2, reason: "bad_ephpub", ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — malformed payload", status: 400 };
  }
  if (iv.length !== 12) {
    auditLog({ event: "import_failed", v: 2, reason: "bad_iv", ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — malformed payload", status: 400 };
  }
  if (ct.length < 17) { // at least 16-byte auth tag + 1 byte ciphertext
    auditLog({ event: "import_failed", v: 2, reason: "short_ct", ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — malformed payload", status: 400 };
  }

  try {
    // Reconstruct SPKI DER prefix for P-256 so createPublicKey can parse it.
    // Prefix is the fixed 26-byte AlgorithmIdentifier for id-ecPublicKey + P-256;
    // we extracted the matching 65-byte raw form at keypair generation, so the
    // inverse is just prefix || raw.
    const SPKI_P256_PREFIX = Buffer.from(
      "3059301306072a8648ce3d020106082a8648ce3d030107034200",
      "hex",
    );
    const spki = Buffer.concat([SPKI_P256_PREFIX, ephPubRaw]);
    const ephPubKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });

    const sharedSecret = crypto.diffieHellman({
      privateKey: _importKeypair.privateKeyObj,
      publicKey: ephPubKey,
    });

    // HKDF-SHA256 — matches the browser's parameters exactly (empty salt,
    // "ffai-import-v2" info, 32-byte output). Any deviation on either side
    // makes decryption fail with AES-GCM auth tag mismatch.
    const aesKey = crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from("ffai-import-v2"), 32);

    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(aesKey), iv);
    const authTag = ct.slice(ct.length - 16);
    const encrypted = ct.slice(0, ct.length - 16);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return { plaintext };
  } catch (err) {
    console.warn(`[ffai] v2 decrypt failed: ${err.message}`);
    auditLog({ event: "import_failed", v: 2, reason: "decrypt_failed", ip });
    authGuard.recordFailure(ip);
    return { error: "import failed — blob could not be decrypted", status: 403 };
  }
}

// ── Route: /health ──────────────────────────────────────────────────────────
function handleHealth(req, res, url) {
  // Accept either FFAI_KEY or ADMIN_KEY — use combined check to avoid double-counting failures
  const ip = req.socket?.remoteAddress || "unknown";
  let isAuthed = false;
  if (!authGuard.isBlocked(ip)) {
    const okFfai = !FFAI_KEY || authGuard.checkAuth(req.headers, FFAI_KEY);
    const okAdmin = ADMIN_KEY && authGuard.checkAuth(req.headers, ADMIN_KEY);
    isAuthed = okFfai || okAdmin;
  }
  const detailed = url.searchParams.has("detailed");

  if (detailed && !isAuthed) {
    return sendJson(res, 401, { error: "admin auth required" });
  }

  if (isAuthed) {
    const data = detailed ? pool.healthDetailed() : pool.health();
    // Enrich with memory and connection stats
    data.memory = {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    };
    data.activeSSE = activeSSEConnections.size;
    data.capabilities = capabilities.size;
    if (pool.alerter) data.alerterDedupSize = pool.alerter.dedupSize;
    if (config.smush?.enabled) data.smush = getSmushStats();
    return sendJson(res, data.status === "ok" ? 200 : 503, data);
  }

  // Unauthenticated: bare status only
  const data = pool.health();
  sendJson(res, data.status === "ok" ? 200 : 503, { status: data.status });
}

// ── Route: /models (OpenAI-compat model listing) ────────────────────────────
function handleModels(req, res) {
  const now = Date.now();
  if (_modelsCache && (now - _modelsCacheTs) < MODELS_CACHE_TTL) {
    return sendJson(res, 200, _modelsCache);
  }

  const models = [];
  const seen = new Set(); // track model IDs to avoid duplicates

  // Static config models
  for (const name of pool.providerNames()) {
    const provModels = providerConfigs[name]?.models;
    if (Array.isArray(provModels) && provModels.length > 0) {
      for (const modelId of provModels) {
        if (deprecationTracker.isDeprecated(modelId)) continue;
        // Check if discovery has richer metadata for this model
        const info = discovery.getModelInfo(modelId);
        const entry = { id: modelId, object: "model", owned_by: name, provider: name };
        if (info) {
          entry.context_window = info.contextWindow;
          entry.max_output_tokens = info.maxOutputTokens;
          entry.input_types = info.inputTypes;
        }
        models.push(entry);
        seen.add(modelId);
      }
    } else {
      models.push({ id: name, object: "model", owned_by: "ffai", provider: name });
      seen.add(name);
    }
  }

  // Merge discovered models not already in static config
  for (const dm of discovery.getAllModels()) {
    if (!seen.has(dm.id) && !deprecationTracker.isDeprecated(dm.id)) {
      models.push(dm);
      seen.add(dm.id);
    }
  }

  // Inject favorites as virtual provider (models that exist in the full list)
  const favs = config.favorites;
  if (Array.isArray(favs) && favs.length > 0) {
    const modelIndex = new Map(models.map(m => [m.id, m]));
    for (const favId of favs) {
      const source = modelIndex.get(favId);
      if (source) {
        models.push({ ...source, provider: "favorites", _source_provider: source.provider });
      }
    }
  }

  _modelsCache = { object: "list", data: models };
  _modelsCacheTs = now;
  sendJson(res, 200, _modelsCache);
}

// ── Route: /stats ───────────────────────────────────────────────────────────
// Auth is already checked by the main router — no duplicate check here
function handleStats(req, res) {
  const statsData = pool.stats.toJSON();
  statsData.modelLatency = {};
  for (const name of pool.providerNames()) {
    const prov = pool.getProvider(name);
    if (prov.latency) {
      const modelStats = prov.latency.allModelStats();
      Object.assign(statsData.modelLatency, modelStats);
    }
  }
  sendJson(res, 200, statsData);
}

// ── Route: /smush ──────────────────────────────────────────────────────────
// Auth is already checked by the main router — no duplicate check here
// (duplicate checkAuth calls would record false auth failures and eventually IP-block callers)
function handleSmush(req, res) {

  const today = new Date().toISOString().slice(0, 10);

  // Last 30 days
  const monthKeys = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    monthKeys.push(d.toISOString().slice(0, 10));
  }

  // All available days
  const allKeys = Object.keys(pool.stats.data.days);

  const result = {
    enabled: !!config.smush?.enabled,
    today: pool.stats.aggregateSmush([today]),
    month: pool.stats.aggregateSmush(monthKeys),
    lifetime: pool.stats.aggregateSmush(allKeys),
    cacheSize: getSmushStats().cacheSize,
  };

  sendJson(res, 200, result);
}


// __ Route: /savings _________________________________________________________
function handleSavings(req, res) {
  const today = new Date().toISOString().slice(0, 10);

  // Last 30 days
  const monthKeys = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    monthKeys.push(d.toISOString().slice(0, 10));
  }

  // All available days
  const allKeys = Object.keys(pool.stats.data.days);

  const result = {
    today: {
      usage: pool.stats.aggregateUsage([today], MODEL_PRICING),
      compression: pool.stats.aggregateSmush([today]),
    },
    month: {
      usage: pool.stats.aggregateUsage(monthKeys, MODEL_PRICING),
      compression: pool.stats.aggregateSmush(monthKeys),
    },
    lifetime: {
      usage: pool.stats.aggregateUsage(allKeys, MODEL_PRICING),
      compression: pool.stats.aggregateSmush(allKeys),
    },
    smushEnabled: !!config.smush?.enabled,
    cacheSize: getSmushStats().cacheSize,
  };

  sendJson(res, 200, result);
}

// ── Route: /providers ───────────────────────────────────────────────────────
function handleProviders(req, res) {
  const result = {};
  for (const name of pool.providerNames()) {
    const prov = pool.getProvider(name);
    result[name] = {
      keys: prov.keys.length,
      scoring: prov.scorer ? "enabled" : "disabled",
      authScheme: prov.authScheme,
      family: pool.providerFamily(name),
      status: prov.keyStatus(),
      capabilities: capabilities.getByProvider(name),
    };
  }
  sendJson(res, 200, { providers: result });
}

// ── Route: /families ───────────────────────────────────────────────────────
function handleFamilies(req, res) {
  sendJson(res, 200, { families: pool.families() });
}

// ── Route: proxy /family/{familyName}/v1/* ─────────────────────────────────
async function handleFamilyProxy(req, res, familyName, apiPath, reqId) {
  let body;
  try { body = await readBody(req); } catch (err) {
    return sendJson(res, 413, { error: err.message });
  }

  const inputTokens = estimateInputTokens(body);
  let requestModel = null;
  try { const pre = JSON.parse(body.toString()); requestModel = pre?.model || null; } catch {}
  const startTime = Date.now();
  const hardMaxRetries = 3;
  let dynamicMaxRetries = hardMaxRetries;

  for (let attempt = 0; attempt <= dynamicMaxRetries; attempt++) {
    let handle = pool.acquireFromFamily(familyName, { model: requestModel, inputTokens });
    if (!handle) {
      // Wait briefly for key availability (same smart-wait as direct proxy)
      const waitMs = ACQUIRE_WAIT_MS;
      if (waitMs > 0) {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
          if (res.destroyed) return;
          await new Promise(r => setTimeout(r, ACQUIRE_POLL_MS));
          handle = pool.acquireFromFamily(familyName, { model: requestModel, inputTokens });
          if (handle) break;
        }
      }
      if (!handle) {
        return sendJson(res, 429, { error: "All keys rate limited", family: familyName });
      }
    }

    const provName = handle.provider;
    const prov = pool.getProvider(provName);
    const upstream = upstreamUrls[provName];
    if (!upstream) {
      pool.release(provName, handle.key, { success: false, statusCode: 0, model: requestModel });
      return sendJson(res, 500, { error: `no upstream_url for ${provName}` });
    }

    // Pre-send TPM check — reject upfront if request can't fit (same guard as direct proxy)
    if (inputTokens > 0 && prov.scorer) {
      const modelLimits = prov.scorer._getModelLimits(requestModel);
      const provTpm = modelLimits.tpm || 0;
      if (provTpm > 0 && inputTokens > provTpm) {
        pool.release(provName, handle.key, { success: true, statusCode: 413, model: requestModel });
        return sendJson(res, 413, {
          error: "request_too_large",
          message: `Estimated ${inputTokens} tokens exceeds ${provName} TPM limit of ${provTpm}. Use a provider with higher TPM or reduce context size.`,
          provider: provName, family: familyName, model: requestModel,
          estimated_tokens: inputTokens, tpm_limit: provTpm,
        });
      }
    }

    const { body: sanitizedBody, modified } = sanitize(body, { provider: provName, family: familyName });

    // Family routing: remap model field if provider has model_aliases configured.
    // This handles cross-provider model name differences within a family.
    let forwardBody = modified ? Buffer.from(sanitizedBody) : body;
    try {
      const parsed = JSON.parse(forwardBody.toString());
      // Remap model via provider's alias table if the model doesn't match provider's known models
      if (parsed.model && prov.scorer) {
        const resolved = prov.scorer._resolveModel(parsed.model);
        if (resolved && resolved !== parsed.model) {
          parsed.model = resolved;
          forwardBody = Buffer.from(JSON.stringify(parsed));
        }
      }
      if (parsed.messages && prov.injectThoughtSignatures(parsed.messages)) {
        forwardBody = Buffer.from(JSON.stringify(parsed));
      }
    } catch {}

    try {
      const upstream_res = await forward(upstream, handle.key, prov, req.method, apiPath, req.headers, forwardBody, providerTimeouts[provName]);
      const statusCode = upstream_res.statusCode;

      // Exception-type retry policy
      const typeMaxRetries = Math.min(prov.maxRetriesFor(statusCode), hardMaxRetries);
      dynamicMaxRetries = Math.min(dynamicMaxRetries, typeMaxRetries);

      if (prov.isRetryable(statusCode) && attempt < dynamicMaxRetries) {
        // Read 429 body for provider-specific parsing
        let errorBody = "";
        if (statusCode === 429) {
          errorBody = await new Promise(r => {
            let buf = ""; upstream_res.on("data", c => { if (buf.length < 4096) buf += c; });
            upstream_res.on("end", () => r(buf)); upstream_res.on("error", () => r(buf));
          });
        } else {
          upstream_res.resume();
        }
        const retryAfter = upstream_res.headers["retry-after"] || upstream_res.headers["retry-after-ms"];
        const errorContext = statusCode === 429 ? parse429(provName, errorBody, upstream_res.headers) : undefined;
        const latencyMs = Date.now() - startTime;
        pool.release(provName, handle.key, { success: false, statusCode, retryAfter, inputTokens, latencyMs, model: requestModel, errorContext });
        // Instant retry if other healthy keys exist; backoff only when pool is stressed
        const status = prov.keyStatus();
        if (status.available <= 1) {
          const delay = Math.min(100 * Math.pow(2, attempt), 2000);
          await new Promise(r => setTimeout(r, delay));
        }
        continue;
      }

      // ── Deprecation detection for 400/404 (family proxy) ─────────────────
      if ((statusCode === 404 || statusCode === 400) && requestModel) {
        const depBody = await new Promise(r => {
          let buf = ""; upstream_res.on("data", c => { if (buf.length < 4096) buf += c; });
          upstream_res.on("end", () => r(buf)); upstream_res.on("error", () => r(buf));
        });
        if (deprecationTracker.check(statusCode, depBody, requestModel, provName)) {
          const latencyMs = Date.now() - startTime;
          pool.release(provName, handle.key, { success: true, statusCode, inputTokens, latencyMs, model: requestModel });
          const depHeaders = { "content-type": "application/json", "x-ffai-provider": provName, "x-ffai-request-id": reqId, "x-ffai-family": familyName, "x-ffai-deprecated": "true", "x-ffai-latency-ms": String(latencyMs) };
          res.writeHead(statusCode, depHeaders);
          res.end(_redactKeys(depBody));
          return;
        }
        // Not deprecated — send already-read body (redact potential key leaks)
        const depRespHeaders = { "x-ffai-provider": provName, "x-ffai-request-id": reqId, "x-ffai-family": familyName, "x-ffai-latency-ms": String(Date.now() - startTime) };
        for (const [k, v] of Object.entries(upstream_res.headers)) {
          if (k.toLowerCase() === "content-type") depRespHeaders[k] = v;
        }
        const latencyMs = Date.now() - startTime;
        pool.release(provName, handle.key, { success: false, statusCode, inputTokens, latencyMs, model: requestModel });
        res.writeHead(statusCode, depRespHeaders);
        res.end(_redactKeys(depBody));
        return;
      }

      const FORWARD_RESP_HEADERS = ["content-type", "content-length", "transfer-encoding", "retry-after", "retry-after-ms", "x-request-id", "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "anthropic-ratelimit-requests-limit", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-limit", "anthropic-ratelimit-tokens-remaining", "openai-processing-ms", "openai-model", "cache-control", "vary"];
      const respHeaders = {};
      for (const [k, v] of Object.entries(upstream_res.headers)) {
        if (FORWARD_RESP_HEADERS.includes(k.toLowerCase())) respHeaders[k] = v;
      }
      if (modified) respHeaders["x-ffai-modified"] = "true";
      respHeaders["x-ffai-provider"] = provName;
      respHeaders["x-ffai-request-id"] = reqId;
      respHeaders["x-ffai-family"] = familyName;
      respHeaders["x-ffai-latency-ms"] = String(Date.now() - startTime);

      const util = pool.utilization(provName, requestModel);
      if (util != null) respHeaders["x-ffai-utilization"] = util.toFixed(2);

      res.writeHead(upstream_res.statusCode, respHeaders);

      const isSSE = (upstream_res.headers["content-type"] || "").includes("text/event-stream");

      if (isSSE) {
        if (prov.scorer) prov.scorer.startStream(handle.key);
        activeSSEConnections.add(res);
        res.on("close", () => activeSSEConnections.delete(res));

        const streamTimeout = SSE_TIMEOUT > 0 ? SSE_TIMEOUT : Math.max(REQUEST_TIMEOUT * 3, 360000);
        let sseTimedOut = false;
        const sseTimer = setTimeout(() => {
          sseTimedOut = true;
          upstream_res.destroy();
          if (!res.writableEnded) { try { res.write("data: [DONE]\n\n"); } catch {} res.end(); }
        }, streamTimeout);

        let pendingSSE = "";
        let released = false;
        let ttftMs = null;

        upstream_res.on("data", (chunk) => {
          if (ttftMs === null) ttftMs = Date.now() - startTime;
          if (!sseTimedOut && !res.writableEnded && !res.destroyed) {
            const ok = res.write(chunk);
            if (!ok) { upstream_res.pause(); res.once("drain", () => upstream_res.resume()); }
          }
          pendingSSE += chunk.toString();
          if (pendingSSE.length > 262144) pendingSSE = pendingSSE.slice(-8192);
          const parts = pendingSSE.split("\n\n");
          pendingSSE = parts.pop() || "";
          for (const part of parts) {
            if (!part.trim()) continue;
            if (part.includes('"tool_calls"') || part.includes('"thought_signature"')) {
              for (const parsed of parseSSELines(part)) prov.extractThoughtSignatures(parsed);
            }
            if (prov.scorer && !released && part.includes('"usage"')) {
              for (const parsed of parseSSELines(part)) {
                if (parsed?.usage) {
                  const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                  if (outTokens > 0) {
                    const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
                    pool.release(provName, handle.key, { success: true, statusCode, outputTokens: outTokens, inputTokens, latencyMs: Date.now() - startTime, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
                    released = true;
                    if (prov.scorer) prov.scorer.endStream(handle.key);
                  }
                }
              }
            }
          }
        });

        upstream_res.on("end", () => {
          clearTimeout(sseTimer);
          activeSSEConnections.delete(res);
          if (pendingSSE.trim()) {
            for (const parsed of parseSSELines(pendingSSE)) {
              prov.extractThoughtSignatures(parsed);
              if (prov.scorer && !released && parsed?.usage) {
                const outTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
                if (outTokens > 0) {
                  const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
                  pool.release(provName, handle.key, { success: true, statusCode, outputTokens: outTokens, inputTokens, latencyMs: Date.now() - startTime, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
                  released = true;
                  if (prov.scorer) prov.scorer.endStream(handle.key);
                }
              }
            }
          }
          if (!res.writableEnded) res.end();
          if (!released) {
            const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
            pool.release(provName, handle.key, { success: statusCode < 400, statusCode, inputTokens, retryAfter: upstream_res.headers["retry-after"], latencyMs: Date.now() - startTime, ttftMs, model: requestModel, rateLimitHeaders: rlHeaders });
            if (prov.scorer) prov.scorer.endStream(handle.key);
          }
        });

        upstream_res.on("error", (err) => {
          clearTimeout(sseTimer);
          activeSSEConnections.delete(res);
          res.destroy();
          if (!released) {
            pool.release(provName, handle.key, { success: false, statusCode: 0, inputTokens, latencyMs: Date.now() - startTime, model: requestModel });
            released = true;
          }
          if (prov.scorer) prov.scorer.endStream(handle.key);
        });
        res.on("close", () => { clearTimeout(sseTimer); if (!upstream_res.destroyed) upstream_res.destroy(); });
      } else {
        let respBody = "";
        let released = false;

        upstream_res.on("data", (chunk) => {
          if (!res.writableEnded && !res.destroyed) {
            const ok = res.write(chunk);
            if (!ok) { upstream_res.pause(); res.once("drain", () => upstream_res.resume()); }
          }
          if (respBody.length < 65536) respBody += chunk.toString();
        });
        upstream_res.on("error", (err) => {
          res.destroy();
          if (!released) {
            pool.release(provName, handle.key, { success: false, statusCode: 0, inputTokens, latencyMs: Date.now() - startTime, model: requestModel });
            released = true;
          }
        });
        res.on("close", () => { if (!upstream_res.destroyed) upstream_res.destroy(); });

        upstream_res.on("end", () => {
          if (!res.writableEnded) res.end();
          if (released) return;
          released = true;
          const latencyMs = Date.now() - startTime;
          let outputTokens = 0;
          try {
            const parsed = JSON.parse(respBody);
            if (parsed?.usage) outputTokens = parsed.usage.completion_tokens || parsed.usage.total_tokens || 0;
            prov.extractThoughtSignatures(parsed);
          } catch {}

          const rlHeaders = collectRateLimitHeaders(upstream_res.headers);
          pool.release(provName, handle.key, {
            success: statusCode < 400, statusCode, inputTokens, outputTokens,
            retryAfter: upstream_res.headers["retry-after"] || upstream_res.headers["retry-after-ms"],
            latencyMs, model: requestModel, rateLimitHeaders: rlHeaders,
          });
        });
      }
      return;

    } catch (err) {
      const latencyMs = Date.now() - startTime;
      pool.release(provName, handle.key, { success: false, statusCode: 0, inputTokens, latencyMs, model: requestModel });
      dynamicMaxRetries = Math.min(dynamicMaxRetries, prov.maxRetriesFor(0));
      if (attempt >= dynamicMaxRetries) {
        return sendJson(res, 502, { error: "upstream error", provider: provName, family: familyName });
      }
      // Instant retry if healthy keys available; backoff only when stressed
      const status = prov.keyStatus();
      if (status.available <= 1) {
        await new Promise(r => setTimeout(r, Math.min(100 * Math.pow(2, attempt), 2000)));
      }
    }
  }

  sendJson(res, 502, { error: "all retries exhausted", family: familyName });
}

// ── Main request handler ────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // Request correlation ID — threaded through logs and response headers
  const reqId = crypto.randomBytes(4).toString("hex");
  res.setHeader("x-ffai-request-id", reqId);

  // Public: /health (basic)
  if (pathname === "/health" && req.method === "GET") {
    return handleHealth(req, res, url);
  }

  // Auth check helper — records failure only once for the combined key check.
  // isProxy=true restricts to FFAI_KEY only (ADMIN_KEY should not reach proxy routes).
  const ip = req.socket?.remoteAddress || "unknown";
  if (authGuard.isBlocked(ip)) return sendJson(res, 401, { error: "unauthorized" });

  function requireAuth(isProxy = false) {
    const okFfai = !FFAI_KEY || authGuard.checkAuth(req.headers, FFAI_KEY);
    if (okFfai) return true;
    if (!isProxy) {
      const okAdmin = ADMIN_KEY && authGuard.checkAuth(req.headers, ADMIN_KEY);
      if (okAdmin) return true;
    }
    authGuard.recordFailure(ip);
    return false;
  }

  // ── Admin/info routes (accept FFAI_KEY or ADMIN_KEY) ────────────────────

  // /models
  if (pathname === "/models" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleModels(req, res);
  }

  // /providers
  if (pathname === "/providers" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleProviders(req, res);
  }

  // /stats
  if (pathname === "/stats" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleStats(req, res);
  }

  // /smush
  if (pathname === "/smush" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleSmush(req, res);
  }


  // /savings
  if (pathname === "/savings" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleSavings(req, res);
  }

  // /families
  if (pathname === "/families" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return handleFamilies(req, res);
  }

  // /capabilities
  if (pathname === "/capabilities" && req.method === "GET") {
    if (!requireAuth()) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, capabilities.getAll());
  }

  // /generate-import — generates encrypted HTML import page (ADMIN_KEY only)
  if (pathname === "/generate-import" && req.method === "GET") {
    if (!ADMIN_KEY || !authGuard.checkAuth(req.headers, ADMIN_KEY)) { authGuard.recordFailure(ip); return sendJson(res, 401, { error: "unauthorized" }); }
    return handleGenerateImport(req, res);
  }

  // /import — receive encrypted key payloads (no auth — the token IS the auth)
  if (pathname === "/import" && req.method === "POST") {
    return handleImport(req, res);
  }

  // ── Proxy routes (FFAI_KEY only — ADMIN_KEY cannot proxy requests) ──────

  // /v1/* — auto-route based on model in request body
  if (pathname.startsWith("/v1/") && req.method === "POST") {
    if (!requireAuth(true)) return sendJson(res, 401, { error: "unauthorized" });
    return handleAutoRoute(req, res, pathname, reqId);
  }

  // /family/{familyName}/v1/* — proxy via family-based routing
  const familyMatch = pathname.match(/^\/family\/([a-z0-9_-]+)(\/v1\/.*)$/);
  if (familyMatch) {
    if (!requireAuth(true)) return sendJson(res, 401, { error: "unauthorized" });
    return handleFamilyProxy(req, res, familyMatch[1], familyMatch[2], reqId);
  }

  // /{provider}/v1/* — proxy to upstream with key rotation
  const proxyMatch = pathname.match(/^\/([a-z0-9_-]+)(\/v1\/.*)$/);
  if (proxyMatch) {
    if (!requireAuth(true)) return sendJson(res, 401, { error: "unauthorized" });
    return handleProxy(req, res, proxyMatch[1], proxyMatch[2], reqId);
  }

  sendJson(res, 404, { error: "not found" });
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(`[ffai] Request error: ${err.stack || err.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[ffai] FATAL: Port ${PORT} is already in use. Is another FFAI instance running?`);
  } else if (err.code === "EACCES") {
    console.error(`[ffai] FATAL: Permission denied binding to ${BIND}:${PORT}`);
  } else {
    console.error(`[ffai] FATAL: Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  const actualPort = server.address().port;
  console.log(`[ffai] Bridge listening on ${BIND}:${actualPort}`);
  console.log(`[ffai] Providers: ${pool.providerNames().join(", ") || "(none)"}`);
  console.log(`[ffai] Auth: ${FFAI_KEY ? "enabled" : "DISABLED (no FFAI_KEY)"}`);
  if (ALERT_WEBHOOK_URL) console.log(`[ffai] Alerts: ${ALERT_WEBHOOK_URL}`);
  // Start model discovery (non-blocking)
  discovery.refresh().catch(err => console.warn(`[ffai] Initial model discovery failed: ${err.message}`));

  if (VALIDATE_KEYS) {
    console.log(`[ffai] Key validation: running startup probe (costs 1 request per key — disable for free tiers)`);
    pool.validateKeys(upstreamUrls, VALIDATE_TIMEOUT).then(result => {
      if (result.invalid > 0) {
        console.warn(`[ffai] Key validation: ${result.valid}/${result.total} valid, ${result.invalid} invalid`);
        for (const err of result.errors) console.warn(`[ffai]   ✗ ${err}`);
      } else {
        console.log(`[ffai] Key validation: all ${result.total} keys valid`);
      }
    }).catch(err => {
      console.error(`[ffai] Key validation failed: ${err.message}`);
    });
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
const DRAIN_TIMEOUT_MS = envInt("FFAI_DRAIN_TIMEOUT", 10000);
let _shuttingDown = false;

async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[ffai] ${signal} received, shutting down...`);

  // Stop accepting new connections
  server.close();

  // Drain active SSE connections with timeout
  if (activeSSEConnections.size > 0) {
    console.log(`[ffai] draining ${activeSSEConnections.size} active SSE connection(s) (${DRAIN_TIMEOUT_MS}ms budget)`);

    // Give in-flight SSE streams time to finish naturally
    const drainDeadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (activeSSEConnections.size > 0 && Date.now() < drainDeadline) {
      await new Promise(r => setTimeout(r, 250));
    }

    // Force-close any remaining connections after drain timeout
    if (activeSSEConnections.size > 0) {
      console.log(`[ffai] force-closing ${activeSSEConnections.size} SSE connection(s) after drain timeout`);
      for (const sseRes of activeSSEConnections) {
        try { sseRes.write("data: [DONE]\n\n"); sseRes.end(); } catch {}
      }
      activeSSEConnections.clear();
    }
  }

  // Clean up timers and flush state
  authGuard.stop();
  if (pool.alerter) pool.alerter.destroy();
  await pool.shutdown();
  console.log(`[ffai] shutdown complete`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGHUP", () => {
  console.log("[ffai] SIGHUP received, reloading config...");
  try {
    const newConfig = tryLoadConfig();
    if (!newConfig) return; // tryLoadConfig already logged the error

    // Validate before applying
    const { errors, warnings } = validateConfig(newConfig);
    for (const w of warnings) console.warn(`[ffai:config] WARNING: ${w}`);
    if (errors.length > 0) {
      for (const e of errors) console.error(`[ffai:config] ERROR: ${e}`);
      console.error(`[ffai] Config reload aborted: ${errors.length} validation error(s)`);
      return;
    }

    const newProviderConfigs = {};
    const newUpstreamUrls = {};
    const newProviderTimeouts = {};
    const newProviderAcquireWait = {};
    for (const [name, pconf] of Object.entries(newConfig.providers || {})) {
      const resolved = { ...pconf, keys: resolveKeys(pconf) };
      newProviderConfigs[name] = resolved;
      newUpstreamUrls[name] = (pconf.upstream_url || "").replace(/\/+$/, "");
      if (pconf.request_timeout) newProviderTimeouts[name] = pconf.request_timeout;
      if (pconf.acquire_wait_ms != null) newProviderAcquireWait[name] = pconf.acquire_wait_ms;
    }

    pool.reload(newProviderConfigs);

    // Update upstream URLs and provider configs
    for (const [name, url] of Object.entries(newUpstreamUrls)) {
      upstreamUrls[name] = url;
    }
    // Remove upstream URLs for providers that no longer exist
    for (const name of Object.keys(upstreamUrls)) {
      if (!newProviderConfigs[name]) delete upstreamUrls[name];
    }
    for (const [name, conf] of Object.entries(newProviderConfigs)) {
      providerConfigs[name] = conf;
    }
    for (const name of Object.keys(providerConfigs)) {
      if (!newProviderConfigs[name]) delete providerConfigs[name];
    }

    // Update per-provider timeouts and acquire waits
    for (const name of Object.keys(providerTimeouts)) delete providerTimeouts[name];
    Object.assign(providerTimeouts, newProviderTimeouts);
    for (const name of Object.keys(providerAcquireWait)) delete providerAcquireWait[name];
    Object.assign(providerAcquireWait, newProviderAcquireWait);

    // Invalidate models cache
    _modelsCache = null;
    _modelsCacheTs = 0;

    // Update pricing — clear if removed from config
    pool._pricing = newConfig.pricing || {};

    // Update favorites
    config.favorites = newConfig.favorites || [];

    // Reload smush config — clear if removed from config
    resetSmush();
    config.smush = newConfig.smush || null;

    // Reload import tokens
    config.import_tokens = newConfig.import_tokens || [];

    // Re-discover models with new provider config
    discovery.refresh().catch(err => console.warn(`[ffai] Post-reload discovery failed: ${err.message}`));

    console.log(`[ffai] Config reloaded: ${pool.providerNames().join(", ") || "(none)"}`);
  } catch (err) {
    console.error(`[ffai] Config reload failed: ${err.message}`);
  }
});

process.on("uncaughtException", (err) => {
  console.error(`[ffai] Uncaught exception: ${err.stack}`);
  pool.stats.flushSync();
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[ffai] Unhandled rejection: ${reason?.stack || reason}`);
});
