const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8002", 10);
const BIND_ADDRESS = (process.env.BIND_ADDRESS || "0.0.0.0").trim();
const MODE = (process.env.MODE || "proxy").toLowerCase();
const UPSTREAM_URL = (process.env.UPSTREAM_URL || "").replace(/\/+$/, "");
const KEYS_VAR = (process.env.KEYS_VAR || "API_KEYS").trim();
const KEYS = (process.env[KEYS_VAR] || "").split(",").map((k) => k.trim()).filter(Boolean);
const AUTH_SCHEME = (process.env.AUTH_SCHEME || "bearer").toLowerCase();
const AUTH_HEADER = (process.env.AUTH_HEADER || "authorization").toLowerCase();
const AUTH_QUERY = (process.env.AUTH_QUERY || "key").trim();
const ALLOWED_PATHS = (process.env.ALLOWED_PATHS || "").trim();
const MAX_RETRIES = Math.min(KEYS.length, parseInt(process.env.MAX_RETRIES || "3", 10));
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || "120000", 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || String(2 * 1024 * 1024), 10);
const DEFAULT_COOLDOWN = parseInt(process.env.DEFAULT_COOLDOWN || "60", 10);
const MAX_COOLDOWN = parseInt(process.env.MAX_COOLDOWN || "300", 10);
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();
const ALERT_TIMEOUT = parseInt(process.env.ALERT_TIMEOUT || "5000", 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || "5000", 10);
const STATS_FILE = process.env.STATS_FILE || path.join(".", "data", "stats.json");
const STATS_FLUSH_INTERVAL = parseInt(process.env.STATS_FLUSH_INTERVAL || "60000", 10);
const STATS_RETENTION_DAYS = parseInt(process.env.STATS_RETENTION_DAYS || "7", 10);
const RETRYABLE_STATUSES = (process.env.RETRYABLE_STATUSES || "429,502,503").split(",").map((s) => parseInt(s.trim(), 10)).filter(Boolean);

// Auth for inbound requests (empty = no auth required)
const PROXY_KEY = (process.env.PROXY_KEY || "").trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();

// Circuit breaker: auto-disable after N consecutive errors in a time window
const CB_THRESHOLD = parseInt(process.env.CB_THRESHOLD || "0", 10); // 0 = disabled
const CB_WINDOW = parseInt(process.env.CB_WINDOW || "60000", 10); // ms
const CB_COOLDOWN = parseInt(process.env.CB_COOLDOWN || "120000", 10); // ms to stay open

// Parse allowed path prefixes (empty = allow all paths)
const PATH_PREFIXES = ALLOWED_PATHS ? ALLOWED_PATHS.split(",").map((p) => p.trim()).filter(Boolean) : [];

// Parse and validate upstream URL at startup
let EXPECTED_HOST = null;
if (UPSTREAM_URL) {
  try {
    EXPECTED_HOST = new URL(UPSTREAM_URL).hostname;
  } catch (err) {
    console.error(`[keymux] FATAL: UPSTREAM_URL is not a valid URL: ${UPSTREAM_URL}`);
    process.exit(1);
  }
}

// Hop-by-hop headers that should not be forwarded
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-connection",
]);

// ── Validation ───────────────────────────────────────────────────────────────
if (!KEYS.length) {
  console.error(`[keymux] FATAL: No keys found in $${KEYS_VAR} (set KEYS_VAR to point to your env var)`);
  process.exit(1);
}

if (!["proxy", "rotation"].includes(MODE)) {
  console.error(`[keymux] FATAL: MODE must be "proxy" or "rotation", got "${MODE}"`);
  process.exit(1);
}

if (MODE === "proxy" && !UPSTREAM_URL) {
  console.error(`[keymux] FATAL: UPSTREAM_URL is required in proxy mode`);
  process.exit(1);
}

if (!["bearer", "query", "header", "none"].includes(AUTH_SCHEME)) {
  console.error(`[keymux] FATAL: AUTH_SCHEME must be "bearer", "query", "header", or "none", got "${AUTH_SCHEME}"`);
  process.exit(1);
}

// ── Key ID helper (collision-safe) ────────────────────────────────���──────────
// Build unique short IDs for each key (use more chars if last4 collides)
function buildKeyIds(keys) {
  const ids = new Map();
  for (let len = 4; len <= 12; len++) {
    ids.clear();
    const suffixes = keys.map((k) => k.slice(-len));
    const unique = new Set(suffixes).size === keys.length;
    if (unique || len === 12) {
      keys.forEach((k, i) => ids.set(k, "…" + suffixes[i]));
      break;
    }
  }
  // Fallback: append index if still colliding
  if (ids.size !== keys.length) {
    ids.clear();
    keys.forEach((k, i) => ids.set(k, `…${k.slice(-4)}#${i}`));
  }
  return ids;
}

const KEY_IDS = buildKeyIds(KEYS);
function keyId(k) { return KEY_IDS.get(k) || "…" + k.slice(-4); }

// ── Stats ───────────────────────────────────��────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }

function emptyDayStats() {
  const perKey = {};
  for (const k of KEYS) {
    perKey[keyId(k)] = { requests: 0, rateLimited: 0, errors: 0 };
  }
  return { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey };
}

function loadStats() {
  try {
    const raw = fs.readFileSync(STATS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.startedAt || !parsed.days || typeof parsed.days !== "object") throw new Error("invalid");
    return parsed;
  } catch {
    return { startedAt: Date.now(), days: {} };
  }
}

const stats = loadStats();
let statsDirty = false;

function getDay(date) {
  const key = date || todayKey();
  if (!stats.days[key]) stats.days[key] = emptyDayStats();
  return stats.days[key];
}

function ensureKeyEntries(day) {
  for (const k of KEYS) {
    const kid = keyId(k);
    if (!day.perKey[kid]) day.perKey[kid] = { requests: 0, rateLimited: 0, errors: 0 };
  }
}

function recordRequest(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.requests++;
  day.perKey[keyId(key)].requests++;
  statsDirty = true;
}

function recordRateLimit(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.rateLimited++;
  day.perKey[keyId(key)].rateLimited++;
  statsDirty = true;
}

function recordError(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.errors++;
  day.perKey[keyId(key)].errors++;
  statsDirty = true;
}

function recordAllKeysExhausted() {
  const day = getDay();
  day.allKeysExhausted++;
  statsDirty = true;
}

function pruneDays() {
  const keys = Object.keys(stats.days).sort();
  while (keys.length > STATS_RETENTION_DAYS) {
    delete stats.days[keys.shift()];
  }
}

function flushStats() {
  if (!statsDirty) return;
  pruneDays();
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp file then rename
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
    statsDirty = false;
  } catch (err) {
    console.error(`[keymux] stats flush error: ${err.message}`);
  }
}

const flushInterval = setInterval(flushStats, STATS_FLUSH_INTERVAL);

// ── Circuit breaker ────────────────────────────────��─────────────────────────
let cbErrors = [];       // timestamps of consecutive errors
let cbOpenUntil = 0;     // circuit open until this timestamp (0 = closed)

function cbRecordError() {
  if (!CB_THRESHOLD) return; // disabled
  const now = Date.now();
  cbErrors.push(now);
  // Keep only errors within the window
  cbErrors = cbErrors.filter((t) => now - t < CB_WINDOW);
  if (cbErrors.length >= CB_THRESHOLD) {
    cbOpenUntil = now + CB_COOLDOWN;
    cbErrors = [];
    const day = getDay();
    day.circuitBreaks = (day.circuitBreaks || 0) + 1;
    statsDirty = true;
    sendAlert("circuit_open", `Circuit breaker tripped: ${CB_THRESHOLD} errors in ${CB_WINDOW / 1000}s. Blocking requests for ${CB_COOLDOWN / 1000}s.`);
    console.error(`[keymux] CIRCUIT OPEN — blocking all requests for ${CB_COOLDOWN / 1000}s`);
  }
}

function cbRecordSuccess() {
  if (!CB_THRESHOLD) return;
  cbErrors = []; // reset on success
}

function cbIsOpen() {
  if (!CB_THRESHOLD) return false;
  if (Date.now() < cbOpenUntil) return true;
  if (cbOpenUntil > 0) {
    cbOpenUntil = 0;
    console.log(`[keymux] Circuit breaker closed — resuming requests`);
  }
  return false;
}

// ── Key rotation state ───────────────────────────────────────────────────────
let index = 0;
const cooldowns = new Map(); // key → cooldownUntilMs

function getNextKey() {
  const now = Date.now();
  for (let i = 0; i < KEYS.length; i++) {
    const candidate = KEYS[(index + i) % KEYS.length];
    if ((cooldowns.get(candidate) || 0) < now) {
      index = (index + i + 1) % KEYS.length;
      return candidate;
    }
  }
  return null;
}

function allKeysExhaustedResponse(res) {
  const now = Date.now();
  const vals = [...cooldowns.values()];
  const shortest = vals.length ? Math.min(...vals.map((t) => Math.max(0, Math.ceil((t - now) / 1000)))) : DEFAULT_COOLDOWN;
  recordAllKeysExhausted();
  sendAlert("all_keys_exhausted", `All ${KEYS.length} keys are rate limited. Shortest cooldown: ${shortest}s.`);
  res.writeHead(429, { "content-type": "application/json", "retry-after": String(shortest) });
  res.end(JSON.stringify({ error: "All keys rate limited", retry_after: shortest }));
}

function cooldownKey(key, retryAfterHeader) {
  const raw = parseInt(retryAfterHeader, 10) || DEFAULT_COOLDOWN;
  const secs = Math.min(raw, MAX_COOLDOWN); // cap cooldown
  cooldowns.set(key, Date.now() + secs * 1000);
  console.log(`[keymux] ${keyId(key)} rate-limited, cooling ${secs}s`);
  recordRateLimit(key);
}

// ── Inbound auth ─────────────────────────────��───────────────────────────────
function checkAuth(req, requiredKey) {
  if (!requiredKey) return true; // no auth configured
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${requiredKey}`;
}

function sendUnauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── Webhook alerts (fire-and-forget) ─────────────────────────────────────────
function sendAlert(event, message) {
  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    message,
    stats: { requests_today: getDay().requests, rate_limited_today: getDay().rateLimited },
  });

  if (ALERT_WEBHOOK_URL) {
    try {
      const url = new URL(ALERT_WEBHOOK_URL);
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) },
        timeout: ALERT_TIMEOUT,
      });
      req.on("response", (res) => res.resume()); // drain response
      req.on("error", (err) => console.error(`[keymux] alert webhook error: ${err.message}`));
      req.on("timeout", () => req.destroy());
      req.write(payload);
      req.end();
    } catch (err) {
      console.error(`[keymux] alert webhook error: ${err.message}`);
    }
  }

  console.warn(`[keymux] ALERT: ${event} — ${message}`);
}

// ── Response header filtering ─────────────────────────────────���──────────────
function filterResponseHeaders(rawHeaders) {
  const filtered = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  }
  return filtered;
}

// ── Uptime formatting ────────────────────────────────────────────────────────
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Key status helper ────────────────────────────────��───────────────────────
function keyStatus() {
  const now = Date.now();
  const cooling = KEYS.filter((k) => (cooldowns.get(k) || 0) > now).length;
  return { total: KEYS.length, available: KEYS.length - cooling, coolingDown: cooling };
}

// ── Proxy forward logic ─────────────────────────────────��────────────────────
function forward(key, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTREAM_URL + urlPath);

    // SSRF protection
    if (url.hostname !== EXPECTED_HOST) {
      return reject(new Error(`SSRF blocked: resolved hostname ${url.hostname} != ${EXPECTED_HOST}`));
    }

    // Inject key via query param if using "query" auth scheme
    if (AUTH_SCHEME === "query") {
      url.searchParams.set(AUTH_QUERY, key);
    }

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (!HOP_HEADERS.has(lk) && lk !== "authorization" && lk !== AUTH_HEADER) {
        fwdHeaders[k] = v;
      }
    }

    if (AUTH_SCHEME === "bearer") {
      fwdHeaders.authorization = `Bearer ${key}`;
    } else if (AUTH_SCHEME === "header") {
      fwdHeaders[AUTH_HEADER] = key;
    }

    fwdHeaders.host = url.host;
    if (body && body.length > 0) {
      fwdHeaders["content-length"] = String(body.length);
    }

    const mod = url.protocol === "https:" ? https : http;
    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: fwdHeaders,
      timeout: REQUEST_TIMEOUT,
    };

    const req = mod.request(opts, (res) => resolve(res));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("upstream timeout")); });
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}

// ── Route: /health ───────────────────────────────────────────────────────────
function handleHealth(req, res) {
  const now = Date.now();
  const ks = keyStatus();
  const day = getDay();
  ensureKeyEntries(day);
  const circuitOpen = cbIsOpen();
  const statusCode = (ks.available === 0 || circuitOpen) ? 503 : 200;
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: statusCode === 200 ? "ok" : "degraded",
    mode: MODE,
    keys: ks.total,
    available: ks.available,
    coolingDown: ks.coolingDown,
    circuitBreaker: CB_THRESHOLD ? (circuitOpen ? "open" : "closed") : "disabled",
    uptime: formatUptime(now - stats.startedAt),
    today: {
      requests: day.requests,
      rateLimited: day.rateLimited,
      allKeysExhausted: day.allKeysExhausted,
      errors: day.errors,
      circuitBreaks: day.circuitBreaks || 0,
      perKey: day.perKey,
    },
  }));
}

// ── Route: /stats ────────────────────────────────────────────────────────────
function handleStats(req, res) {
  if (!checkAuth(req, ADMIN_KEY)) return sendUnauthorized(res);
  const now = Date.now();
  const ks = keyStatus();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    mode: MODE,
    keys: ks.total,
    available: ks.available,
    coolingDown: ks.coolingDown,
    circuitBreaker: CB_THRESHOLD ? (cbIsOpen() ? "open" : "closed") : "disabled",
    uptime: formatUptime(now - stats.startedAt),
    startedAt: new Date(stats.startedAt).toISOString(),
    days: stats.days,
  }));
}

// ── Route: /key (rotation mode only) ─────────────────────────────────────────
function handleKeyRequest(req, res) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  if (cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open" }));
  }

  const key = getNextKey();
  if (!key) return allKeysExhaustedResponse(res);

  recordRequest(key);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ key, upstream_url: UPSTREAM_URL || null }));
}

// ── Route: POST /key/:keyId/cooldown (rotation mode — report rate limit) ─────
function handleCooldownReport(req, res, keyFragment) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  // Require exactly 4 chars to prevent broad matching
  if (keyFragment.length < 4) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key fragment must be at least 4 characters" }));
  }

  const match = KEYS.find((k) => k.endsWith(keyFragment));
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key not found" }));
  }

  // Read body with size limit (1KB max for this endpoint)
  const chunks = [];
  let totalSize = 0;
  req.on("data", (c) => {
    totalSize += c.length;
    if (totalSize <= 1024) chunks.push(c);
  });
  req.on("end", () => {
    if (totalSize > 1024) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "body too large" }));
    }
    let retryAfter = String(DEFAULT_COOLDOWN);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.retry_after) retryAfter = String(body.retry_after);
    } catch {}
    cooldownKey(match, retryAfter);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "cooled", key: keyId(match) }));
  });
}

// ── Route: proxy pass-through (proxy mode only) ─────────────────────────────
async function handleProxy(req, res) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  // Circuit breaker check
  if (cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open — requests temporarily blocked" }));
  }

  // Pre-check Content-Length if available
  const declaredLength = parseInt(req.headers["content-length"], 10);
  if (declaredLength > MAX_BODY_SIZE) {
    res.writeHead(413, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "request body too large", max: MAX_BODY_SIZE }));
  }

  // Collect request body with size limit
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) {
      req.destroy();
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "request body too large", max: MAX_BODY_SIZE }));
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers };

  // Retry loop with key rotation
  // Use MAX_RETRIES + 1 attempts so a single-key setup can cooldown then report 429
  const attempts = MAX_RETRIES + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = getNextKey();
    if (!key) return allKeysExhaustedResponse(res);

    recordRequest(key);

    try {
      const upstream = await forward(key, req.method, req.url, headers, body);

      // Retryable status codes (429, 502, 503, etc.)
      if (RETRYABLE_STATUSES.includes(upstream.statusCode)) {
        upstream.resume(); // drain response before retry
        if (upstream.statusCode === 429) {
          cooldownKey(key, upstream.headers["retry-after"]);
        }
        cbRecordError();
        if (attempt < attempts - 1) continue;
        // Last attempt — pass through the error
        res.writeHead(upstream.statusCode, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `upstream returned ${upstream.statusCode}` }));
      }

      // Success — pipe response
      cbRecordSuccess();
      const safeHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.statusCode, safeHeaders);
      res.on("close", () => { upstream.destroy(); });
      upstream.pipe(res);
      return;
    } catch (err) {
      console.error(`[keymux] ${keyId(key)} error: ${err.message}`);
      recordError(key);
      cbRecordError();
      if (attempt === attempts - 1) {
        res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "upstream error" }));
      }
    }
  }

  res.writeHead(502, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "max retries exhausted" }));
}

// ── Request router ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  // Health — always open (no auth), needed for orchestrators
  if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);

  // Stats — requires ADMIN_KEY if set
  if (req.method === "GET" && req.url === "/stats") return handleStats(req, res);

  // Rotation mode endpoints
  if (MODE === "rotation") {
    if (req.method === "GET" && req.url === "/key") return handleKeyRequest(req, res);

    const cooldownMatch = req.url.match(/^\/key\/([^/]+)\/cooldown$/);
    if (req.method === "POST" && cooldownMatch) {
      return handleCooldownReport(req, res, cooldownMatch[1]);
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", mode: "rotation", endpoints: ["/health", "/stats", "/key", "/key/:id/cooldown"] }));
  }

  // Proxy mode — check allowed path prefixes (if configured)
  if (PATH_PREFIXES.length > 0) {
    const normalized = decodeURIComponent(req.url.split("?")[0]); // normalize for prefix check
    if (!PATH_PREFIXES.some((p) => normalized.startsWith(p))) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden: path not allowed", allowed: PATH_PREFIXES }));
    }
  }

  return handleProxy(req, res);
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[keymux] unhandled: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
});

// Global error handlers — log and keep running
process.on("unhandledRejection", (err) => {
  console.error(`[keymux] unhandled rejection: ${err?.message || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[keymux] uncaught exception: ${err.message}`);
  flushStats();
  process.exit(1);
});

// Graceful shutdown
let forceExitTimer;
function shutdown(signal) {
  console.log(`[keymux] ${signal} received, shutting down...`);
  flushStats();
  clearInterval(flushInterval);
  server.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
  forceExitTimer = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, BIND_ADDRESS, () => {
  console.log(`[keymux] KeyMux on ${BIND_ADDRESS}:${PORT} [${MODE} mode] with ${KEYS.length} key(s) from $${KEYS_VAR} (auth: ${AUTH_SCHEME})`);
  if (MODE === "proxy") console.log(`[keymux] Upstream: ${EXPECTED_HOST}${PATH_PREFIXES.length ? ` | paths: ${PATH_PREFIXES.join(", ")}` : " | paths: all"}`);
  if (MODE === "rotation") console.log(`[keymux] Rotation-only: clients fetch keys via GET /key`);
  if (PROXY_KEY) console.log(`[keymux] Inbound auth: PROXY_KEY required`);
  if (ADMIN_KEY) console.log(`[keymux] Admin auth: ADMIN_KEY required for /stats`);
  if (CB_THRESHOLD) console.log(`[keymux] Circuit breaker: ${CB_THRESHOLD} errors in ${CB_WINDOW / 1000}s → block for ${CB_COOLDOWN / 1000}s`);
  console.log(`[keymux] Stats: ${fs.existsSync(STATS_FILE) ? "loaded from disk" : "fresh start"}`);
});
