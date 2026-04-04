const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8002", 10);
const MODE = (process.env.MODE || "proxy").toLowerCase(); // "proxy" | "rotation"
const LLM_BASE = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const KEYS_VAR = (process.env.KEYS_VAR || "LLM_KEYS").trim();
const KEYS = (process.env[KEYS_VAR] || "").split(",").map((k) => k.trim()).filter(Boolean);
const MAX_RETRIES = Math.min(KEYS.length, parseInt(process.env.MAX_RETRIES || "3", 10));
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || "120000", 10);
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || String(2 * 1024 * 1024), 10);
const DEFAULT_COOLDOWN = parseInt(process.env.DEFAULT_COOLDOWN || "60", 10);
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();
const ALERT_TIMEOUT = parseInt(process.env.ALERT_TIMEOUT || "5000", 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || "5000", 10);
const STATS_FILE = process.env.STATS_FILE || path.join(".", "data", "stats.json");
const STATS_FLUSH_INTERVAL = parseInt(process.env.STATS_FLUSH_INTERVAL || "60000", 10);
const STATS_RETENTION_DAYS = parseInt(process.env.STATS_RETENTION_DAYS || "7", 10);

// Parse expected upstream hostname once at startup for SSRF validation
const EXPECTED_HOST = new URL(LLM_BASE).hostname;

// Hop-by-hop headers that should not be forwarded
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-connection",
]);

if (!KEYS.length) {
  console.error(`[gateway] FATAL: No keys found in $${KEYS_VAR} (set KEYS_VAR to point to your env var)`);
  process.exit(1);
}

if (!["proxy", "rotation"].includes(MODE)) {
  console.error(`[gateway] FATAL: MODE must be "proxy" or "rotation", got "${MODE}"`);
  process.exit(1);
}

// ── Stats ────────────────────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }
function last4(k) { return "…" + k.slice(-4); }

function emptyDayStats() {
  const perKey = {};
  for (const k of KEYS) {
    perKey[last4(k)] = { requests: 0, rateLimited: 0, errors: 0 };
  }
  return { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, perKey };
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
    const k4 = last4(k);
    if (!day.perKey[k4]) day.perKey[k4] = { requests: 0, rateLimited: 0, errors: 0 };
  }
}

function recordRequest(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.requests++;
  day.perKey[last4(key)].requests++;
  statsDirty = true;
}

function recordRateLimit(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.rateLimited++;
  day.perKey[last4(key)].rateLimited++;
  statsDirty = true;
}

function recordError(key) {
  const day = getDay();
  ensureKeyEntries(day);
  day.errors++;
  day.perKey[last4(key)].errors++;
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
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
    statsDirty = false;
  } catch (err) {
    console.error(`[gateway] stats flush error: ${err.message}`);
  }
}

const flushInterval = setInterval(flushStats, STATS_FLUSH_INTERVAL);

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

function cooldownKey(key, retryAfterHeader) {
  const secs = parseInt(retryAfterHeader, 10) || DEFAULT_COOLDOWN;
  cooldowns.set(key, Date.now() + secs * 1000);
  console.log(`[gateway] ${last4(key)} rate-limited, cooling ${secs}s`);
  recordRateLimit(key);
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
      req.on("error", (err) => console.error(`[gateway] alert webhook error: ${err.message}`));
      req.on("timeout", () => req.destroy());
      req.write(payload);
      req.end();
    } catch (err) {
      console.error(`[gateway] alert webhook error: ${err.message}`);
    }
  }

  console.warn(`[gateway] ALERT: ${event} — ${message}`);
}

// ── Response header filtering ────────────────────────────────────────────────
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

// ── Key status helper ────────────────────────────────────────────────────────
function keyStatus() {
  const now = Date.now();
  const cooling = KEYS.filter((k) => (cooldowns.get(k) || 0) > now).length;
  return { total: KEYS.length, available: KEYS.length - cooling, coolingDown: cooling };
}

// ── Proxy forward logic ──────────────────────────────────────────────────────
function forward(key, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(LLM_BASE + urlPath);

    // SSRF protection
    if (url.hostname !== EXPECTED_HOST) {
      return reject(new Error(`SSRF blocked: resolved hostname ${url.hostname} != ${EXPECTED_HOST}`));
    }

    const fwdHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== "authorization") {
        fwdHeaders[k] = v;
      }
    }
    fwdHeaders.authorization = `Bearer ${key}`;
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
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    mode: MODE,
    keys: ks.total,
    available: ks.available,
    coolingDown: ks.coolingDown,
    uptime: formatUptime(now - stats.startedAt),
    today: {
      requests: day.requests,
      rateLimited: day.rateLimited,
      allKeysExhausted: day.allKeysExhausted,
      errors: day.errors,
      perKey: day.perKey,
    },
  }));
}

// ── Route: /stats ────────────────────────────────────────────────────────────
function handleStats(req, res) {
  const now = Date.now();
  const ks = keyStatus();
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    mode: MODE,
    keys: ks.total,
    available: ks.available,
    coolingDown: ks.coolingDown,
    uptime: formatUptime(now - stats.startedAt),
    startedAt: new Date(stats.startedAt).toISOString(),
    days: stats.days,
  }));
}

// ── Route: /key (rotation mode only) ─────────────────────────────────────────
function handleKeyRequest(req, res) {
  const key = getNextKey();
  if (!key) {
    const now = Date.now();
    const shortest = Math.min(...[...cooldowns.values()].map((t) => Math.max(0, Math.ceil((t - now) / 1000))));
    recordAllKeysExhausted();
    sendAlert("all_keys_exhausted", `All ${KEYS.length} keys are rate limited. Shortest cooldown: ${shortest}s.`);
    res.writeHead(429, { "content-type": "application/json", "retry-after": String(shortest) });
    return res.end(JSON.stringify({ error: "All keys rate limited", retry_after: shortest }));
  }

  recordRequest(key);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ key, base_url: LLM_BASE }));
}

// ── Route: POST /key/:keyId/cooldown (rotation mode — report rate limit) ─────
function handleCooldownReport(req, res, keyFragment) {
  // Client reports that a key got 429'd; find the matching key
  const match = KEYS.find((k) => k.endsWith(keyFragment) || last4(k) === "…" + keyFragment);
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key not found" }));
  }

  // Read retry-after from request body or default
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let retryAfter = String(DEFAULT_COOLDOWN);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.retry_after) retryAfter = String(body.retry_after);
    } catch {}
    cooldownKey(match, retryAfter);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "cooled", key: last4(match) }));
  });
}

// ── Route: /v1/* proxy (proxy mode only) ─────────────────────────────────────
async function handleProxy(req, res) {
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
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const key = getNextKey();
    if (!key) {
      const now = Date.now();
      const shortest = Math.min(...[...cooldowns.values()].map((t) => Math.max(0, Math.ceil((t - now) / 1000))));
      recordAllKeysExhausted();
      sendAlert(
        "all_keys_exhausted",
        `All ${KEYS.length} keys are rate limited. Shortest cooldown: ${shortest}s. Requests will fail until a key recovers.`,
      );
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(shortest) });
      return res.end(JSON.stringify({ error: "All keys rate limited", retry_after: shortest }));
    }

    recordRequest(key);

    try {
      const upstream = await forward(key, req.method, req.url, headers, body);

      if (upstream.statusCode === 429) {
        cooldownKey(key, upstream.headers["retry-after"]);
        upstream.resume(); // drain before retry
        continue;
      }

      const safeHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.statusCode, safeHeaders);
      res.on("close", () => { upstream.destroy(); });
      upstream.pipe(res);
      return;
    } catch (err) {
      console.error(`[gateway] ${last4(key)} error: ${err.message}`);
      recordError(key);
      if (attempt === MAX_RETRIES - 1) {
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
  // Common endpoints (both modes)
  if (req.method === "GET" && req.url === "/health") return handleHealth(req, res);
  if (req.method === "GET" && req.url === "/stats") return handleStats(req, res);

  // Rotation mode endpoints
  if (MODE === "rotation") {
    if (req.method === "GET" && req.url === "/key") return handleKeyRequest(req, res);

    // POST /key/<last4>/cooldown — client reports a rate limit
    const cooldownMatch = req.url.match(/^\/key\/([^/]+)\/cooldown$/);
    if (req.method === "POST" && cooldownMatch) {
      return handleCooldownReport(req, res, cooldownMatch[1]);
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", mode: "rotation", endpoints: ["/health", "/stats", "/key", "/key/:id/cooldown"] }));
  }

  // Proxy mode — only allow /v1/ paths
  if (!req.url.startsWith("/v1/")) {
    res.writeHead(403, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "forbidden: only /v1/ paths allowed" }));
  }

  return handleProxy(req, res);
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error(`[gateway] unhandled: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal gateway error" }));
    }
  });
});

// Graceful shutdown
let forceExitTimer;
function shutdown(signal) {
  console.log(`[gateway] ${signal} received, shutting down...`);
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[gateway] KeyMux on :${PORT} [${MODE} mode] with ${KEYS.length} key(s) from $${KEYS_VAR}`);
  if (MODE === "proxy") console.log(`[gateway] Upstream: ${EXPECTED_HOST}`);
  if (MODE === "rotation") console.log(`[gateway] Rotation-only: clients fetch keys via GET /key`);
  console.log(`[gateway] Stats: ${fs.existsSync(STATS_FILE) ? "loaded from disk" : "fresh start"}`);
});
