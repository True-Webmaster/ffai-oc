const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

// ── Global Config (env vars) ─────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8002", 10);
const BIND_ADDRESS = (process.env.BIND_ADDRESS || "0.0.0.0").trim();
const PROXY_KEY = (process.env.PROXY_KEY || "").trim();
const ADMIN_KEY = (process.env.ADMIN_KEY || "").trim();
const ALERT_WEBHOOK_URL = (process.env.ALERT_WEBHOOK_URL || "").trim();
const ALERT_TIMEOUT = parseInt(process.env.ALERT_TIMEOUT || "5000", 10);
const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || "5000", 10);
const STATS_FILE = process.env.STATS_FILE || path.join(".", "data", "stats.json");
const STATS_FLUSH_INTERVAL = parseInt(process.env.STATS_FLUSH_INTERVAL || "60000", 10);
const STATS_RETENTION_DAYS = parseInt(process.env.STATS_RETENTION_DAYS || "7", 10);
const PROVIDERS_FILE = process.env.PROVIDERS_FILE || path.join(".", "providers.json");

// Global defaults — providers inherit these unless they override
const DEFAULTS = {
  mode: "proxy",
  auth_scheme: "bearer",
  auth_header: "authorization",
  auth_query: "key",
  max_retries: 3,
  request_timeout: 120000,
  max_body_size: 2 * 1024 * 1024,
  default_cooldown: 60,
  max_cooldown: 300,
  retryable_statuses: [429, 502, 503],
  cb_threshold: 0,
  cb_window: 60000,
  cb_cooldown: 120000,
  allowed_paths: [],
};

// Hop-by-hop headers that should not be forwarded
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "te",
  "trailer", "upgrade", "proxy-authorization", "proxy-connection",
]);

// ── Load providers.json ──────────────────────────────────────────────────────
function loadProvidersConfig() {
  try {
    const raw = fs.readFileSync(PROVIDERS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[keymux] FATAL: Cannot load ${PROVIDERS_FILE}: ${err.message}`);
    process.exit(1);
  }
}

// ── Key ID helper (collision-safe within a provider) ─────────────────────────
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
  if (ids.size !== keys.length) {
    ids.clear();
    keys.forEach((k, i) => ids.set(k, `…${k.slice(-4)}#${i}`));
  }
  return ids;
}

// ── Provider class (encapsulates all per-provider state) ─────────────────────
class Provider {
  constructor(name, config) {
    this.name = name;
    this.mode = (config.mode || DEFAULTS.mode).toLowerCase();
    this.upstreamUrl = (config.upstream_url || "").replace(/\/+$/, "");
    this.authScheme = (config.auth_scheme || DEFAULTS.auth_scheme).toLowerCase();
    this.authHeader = (config.auth_header || DEFAULTS.auth_header).toLowerCase();
    this.authQuery = config.auth_query || DEFAULTS.auth_query;
    this.maxRetries = config.max_retries ?? DEFAULTS.max_retries;
    this.requestTimeout = config.request_timeout ?? DEFAULTS.request_timeout;
    this.maxBodySize = config.max_body_size ?? DEFAULTS.max_body_size;
    this.defaultCooldown = config.default_cooldown ?? DEFAULTS.default_cooldown;
    this.maxCooldown = config.max_cooldown ?? DEFAULTS.max_cooldown;
    this.retryableStatuses = config.retryable_statuses || DEFAULTS.retryable_statuses;
    this.cbThreshold = config.cb_threshold ?? DEFAULTS.cb_threshold;
    this.cbWindow = config.cb_window ?? DEFAULTS.cb_window;
    this.cbCooldown = config.cb_cooldown ?? DEFAULTS.cb_cooldown;
    this.allowedPaths = config.allowed_paths || DEFAULTS.allowed_paths;

    // Load keys from env var
    const keysVar = config.keys_var || "API_KEYS";
    this.keys = (process.env[keysVar] || "").split(",").map((k) => k.trim()).filter(Boolean);

    // Validate
    if (!this.keys.length) {
      console.error(`[keymux] FATAL: Provider "${name}" — no keys found in $${keysVar}`);
      process.exit(1);
    }
    if (!["proxy", "rotation"].includes(this.mode)) {
      console.error(`[keymux] FATAL: Provider "${name}" — mode must be "proxy" or "rotation", got "${this.mode}"`);
      process.exit(1);
    }
    if (this.mode === "proxy" && !this.upstreamUrl) {
      console.error(`[keymux] FATAL: Provider "${name}" — upstream_url is required in proxy mode`);
      process.exit(1);
    }
    if (!["bearer", "query", "header", "none"].includes(this.authScheme)) {
      console.error(`[keymux] FATAL: Provider "${name}" — auth_scheme must be "bearer", "query", "header", or "none"`);
      process.exit(1);
    }

    // Cap max_retries at key count
    this.maxRetries = Math.min(this.keys.length, this.maxRetries);

    // Parse upstream host for SSRF
    this.expectedHost = null;
    if (this.upstreamUrl) {
      try {
        this.expectedHost = new URL(this.upstreamUrl).hostname;
      } catch {
        console.error(`[keymux] FATAL: Provider "${name}" — upstream_url is not a valid URL: ${this.upstreamUrl}`);
        process.exit(1);
      }
    }

    // Key IDs for logging/stats
    this.keyIds = buildKeyIds(this.keys);

    // Rotation state
    this.index = 0;
    this.cooldowns = new Map();

    // Circuit breaker state
    this.cbErrors = [];
    this.cbOpenUntil = 0;
  }

  keyId(k) { return this.keyIds.get(k) || "…" + k.slice(-4); }

  // ── Key rotation ───────────────────────────────────────────────────────────
  getNextKey() {
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const candidate = this.keys[(this.index + i) % this.keys.length];
      if ((this.cooldowns.get(candidate) || 0) < now) {
        this.index = (this.index + i + 1) % this.keys.length;
        return candidate;
      }
    }
    return null;
  }

  cooldownKey(key, retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    const raw = (Number.isFinite(parsed) && parsed >= 0) ? parsed : this.defaultCooldown;
    const secs = Math.max(0, Math.min(raw, this.maxCooldown));
    this.cooldowns.set(key, Date.now() + secs * 1000);
    console.log(`[keymux:${this.name}] ${this.keyId(key)} rate-limited, cooling ${secs}s`);
    this.recordRateLimit(key);
  }

  keyStatus() {
    const now = Date.now();
    const cooling = this.keys.filter((k) => (this.cooldowns.get(k) || 0) > now).length;
    return { total: this.keys.length, available: this.keys.length - cooling, coolingDown: cooling };
  }

  // ── Circuit breaker ────────────────────────────────────────────────────────
  cbRecordError() {
    if (!this.cbThreshold) return;
    const now = Date.now();
    this.cbErrors.push(now);
    this.cbErrors = this.cbErrors.filter((t) => now - t < this.cbWindow);
    if (this.cbErrors.length >= this.cbThreshold) {
      this.cbOpenUntil = now + this.cbCooldown;
      this.cbErrors = [];
      const day = getProviderDay(this.name);
      day.circuitBreaks = (day.circuitBreaks || 0) + 1;
      statsDirty = true;
      sendAlert("circuit_open", `[${this.name}] Circuit breaker tripped: ${this.cbThreshold} errors in ${this.cbWindow / 1000}s. Blocking for ${this.cbCooldown / 1000}s.`);
      console.error(`[keymux:${this.name}] CIRCUIT OPEN — blocking requests for ${this.cbCooldown / 1000}s`);
    }
  }

  cbRecordSuccess() {
    if (!this.cbThreshold) return;
    this.cbErrors = [];
  }

  cbIsOpen() {
    if (!this.cbThreshold) return false;
    if (Date.now() < this.cbOpenUntil) return true;
    if (this.cbOpenUntil > 0) {
      this.cbOpenUntil = 0;
      console.log(`[keymux:${this.name}] Circuit breaker closed — resuming requests`);
    }
    return false;
  }

  // ── Stats recording ────────────────────────────────────────────────────────
  recordRequest(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.requests++;
    day.perKey[this.keyId(key)].requests++;
    statsDirty = true;
  }

  recordRateLimit(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.rateLimited++;
    day.perKey[this.keyId(key)].rateLimited++;
    statsDirty = true;
  }

  recordError(key) {
    const day = getProviderDay(this.name);
    this._ensureKeyEntries(day);
    day.errors++;
    day.perKey[this.keyId(key)].errors++;
    statsDirty = true;
  }

  recordAllKeysExhausted() {
    const day = getProviderDay(this.name);
    day.allKeysExhausted++;
    statsDirty = true;
  }

  _emptyDayStats() {
    const perKey = {};
    for (const k of this.keys) {
      perKey[this.keyId(k)] = { requests: 0, rateLimited: 0, errors: 0 };
    }
    return { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey };
  }

  _ensureKeyEntries(day) {
    for (const k of this.keys) {
      const kid = this.keyId(k);
      if (!day.perKey[kid]) day.perKey[kid] = { requests: 0, rateLimited: 0, errors: 0 };
    }
  }

  // ── Forwarding (proxy mode) ────────────────────────────────────────────────
  forward(key, method, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
      // Reject path traversal and null bytes
      if (urlPath.includes("\0") || /(?:^|\/)\.\.(?:\/|$)/.test(urlPath)) {
        return reject(new Error("blocked: path traversal or null byte"));
      }

      const base = new URL(this.upstreamUrl);
      const url = new URL(base.pathname.replace(/\/+$/, "") + urlPath, base.origin);

      if (url.hostname !== this.expectedHost) {
        return reject(new Error(`SSRF blocked: ${url.hostname} != ${this.expectedHost}`));
      }

      if (this.authScheme === "query") {
        url.searchParams.set(this.authQuery, key);
      }

      const fwdHeaders = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (!HOP_HEADERS.has(lk) && lk !== "authorization" && lk !== this.authHeader) {
          fwdHeaders[k] = v;
        }
      }

      if (this.authScheme === "bearer") {
        fwdHeaders.authorization = `Bearer ${key}`;
      } else if (this.authScheme === "header") {
        fwdHeaders[this.authHeader] = key;
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
        timeout: this.requestTimeout,
      };

      const req = mod.request(opts, (res) => resolve(res));
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(new Error("upstream timeout")); });
      if (body && body.length > 0) req.write(body);
      req.end();
    });
  }
}

// ── Stats (multi-provider) ───────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10); }

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

// Stats are now nested: stats.days["2026-04-04"].providers.gemini.{requests, perKey, ...}
function getProviderDay(providerName) {
  const dateKey = todayKey();
  if (!stats.days[dateKey]) stats.days[dateKey] = { providers: {} };
  if (!stats.days[dateKey].providers) stats.days[dateKey].providers = {};
  if (!stats.days[dateKey].providers[providerName]) {
    const prov = providers.get(providerName);
    stats.days[dateKey].providers[providerName] = prov ? prov._emptyDayStats() : { requests: 0, rateLimited: 0, allKeysExhausted: 0, errors: 0, circuitBreaks: 0, perKey: {} };
  }
  return stats.days[dateKey].providers[providerName];
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
    const tmp = STATS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(stats, null, 2));
    fs.renameSync(tmp, STATS_FILE);
    statsDirty = false;
  } catch (err) {
    console.error(`[keymux] stats flush error: ${err.message}`);
  }
}

const flushInterval = setInterval(flushStats, STATS_FLUSH_INTERVAL);

// ── Initialize providers ─────────────────────────────────────────────────────
const providersConfig = loadProvidersConfig();
const providers = new Map();

for (const [name, config] of Object.entries(providersConfig)) {
  // Validate provider name (used in URL path)
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    console.error(`[keymux] FATAL: Provider name "${name}" must be lowercase alphanumeric (hyphens/underscores ok, no leading special chars)`);
    process.exit(1);
  }
  providers.set(name, new Provider(name, config));
}

if (providers.size === 0) {
  console.error(`[keymux] FATAL: No providers defined in ${PROVIDERS_FILE}`);
  process.exit(1);
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
function checkAuth(req, requiredKey) {
  if (!requiredKey) return true;
  const auth = req.headers["authorization"] || "";
  const expected = `Bearer ${requiredKey}`;
  if (auth.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

// Effective admin key: ADMIN_KEY if set, otherwise fall back to PROXY_KEY
const EFFECTIVE_ADMIN_KEY = ADMIN_KEY || PROXY_KEY;

function sendUnauthorized(res) {
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── Webhook alerts ───────────────────────────────────────────────────────────
function sendAlert(event, message) {
  const payload = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    message,
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
      req.on("response", (res) => res.resume());
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

// ── Shared helpers ───────────────────────────────────────────────────────────
function filterResponseHeaders(rawHeaders) {
  const filtered = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  }
  return filtered;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Route: /health ───────────────────────────────────────────────────────────
function handleHealth(req, res) {
  const now = Date.now();
  const isAdmin = checkAuth(req, EFFECTIVE_ADMIN_KEY);
  let anyDegraded = false;

  const providerStatuses = {};
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    const circuitOpen = prov.cbIsOpen();
    if (ks.available === 0 || circuitOpen) anyDegraded = true;

    const entry = {
      mode: prov.mode,
      available: ks.available,
      coolingDown: ks.coolingDown,
      circuitBreaker: prov.cbThreshold ? (circuitOpen ? "open" : "closed") : "disabled",
    };

    if (isAdmin) {
      entry.keys = ks.total;
      const day = getProviderDay(name);
      prov._ensureKeyEntries(day);
      entry.today = {
        requests: day.requests,
        rateLimited: day.rateLimited,
        allKeysExhausted: day.allKeysExhausted,
        errors: day.errors,
        circuitBreaks: day.circuitBreaks || 0,
        perKey: day.perKey,
      };
    }

    providerStatuses[name] = entry;
  }

  const statusCode = anyDegraded ? 503 : 200;
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: anyDegraded ? "degraded" : "ok",
    uptime: formatUptime(now - stats.startedAt),
    providers: providerStatuses,
  }));
}

// ── Route: /stats ────────────────────────────────────────────────────────────
function handleStats(req, res) {
  if (!checkAuth(req, EFFECTIVE_ADMIN_KEY)) return sendUnauthorized(res);
  const now = Date.now();

  const providerStatuses = {};
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    providerStatuses[name] = {
      mode: prov.mode,
      keys: ks.total,
      available: ks.available,
      coolingDown: ks.coolingDown,
      circuitBreaker: prov.cbThreshold ? (prov.cbIsOpen() ? "open" : "closed") : "disabled",
    };
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    uptime: formatUptime(now - stats.startedAt),
    startedAt: new Date(stats.startedAt).toISOString(),
    providers: providerStatuses,
    days: stats.days,
  }));
}

// ── Route: /:provider/key (rotation mode) ────────────────────────────────────
function handleKeyRequest(req, res, prov) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  if (prov.cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open", provider: prov.name }));
  }

  const key = prov.getNextKey();
  if (!key) {
    prov.recordAllKeysExhausted();
    sendAlert("all_keys_exhausted", `[${prov.name}] All ${prov.keys.length} keys are rate limited.`);
    res.writeHead(429, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "All keys rate limited", provider: prov.name }));
  }

  prov.recordRequest(key);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ key, upstream_url: prov.upstreamUrl || null, provider: prov.name }));
}

// ── Route: /:provider/key/:id/cooldown (rotation mode) ──────────────────────
function handleCooldownReport(req, res, prov, keyFragment) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  if (keyFragment.length < 4) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key fragment must be at least 4 characters" }));
  }

  const match = prov.keys.find((k) => k.endsWith(keyFragment));
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "key not found", provider: prov.name }));
  }

  const chunks = [];
  let totalSize = 0;
  req.on("data", (c) => {
    totalSize += c.length;
    if (totalSize <= 1024) chunks.push(c);
  });
  req.on("error", (err) => {
    console.error(`[keymux:${prov.name}] cooldown request error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "request error" }));
    }
  });
  req.on("end", () => {
    if (totalSize > 1024) {
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "body too large" }));
    }
    let retryAfter = String(prov.defaultCooldown);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.retry_after) retryAfter = String(body.retry_after);
    } catch {}
    prov.cooldownKey(match, retryAfter);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "cooled", key: prov.keyId(match), provider: prov.name }));
  });
}

// ── Route: /:provider/* (proxy mode) ─────────────────────────────────────────
async function handleProxy(req, res, prov, proxyPath) {
  if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);

  if (prov.cbIsOpen()) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "circuit breaker open", provider: prov.name }));
  }

  // Check allowed paths
  if (prov.allowedPaths.length > 0) {
    let normalized;
    try { normalized = decodeURIComponent(proxyPath.split("?")[0]); } catch { normalized = proxyPath.split("?")[0]; }
    if (!prov.allowedPaths.some((p) => normalized === p || normalized.startsWith(p.endsWith("/") ? p : p + "/"))) {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden: path not allowed" }));
    }
  }

  // Pre-check Content-Length
  const declaredLength = parseInt(req.headers["content-length"], 10);
  if (declaredLength > prov.maxBodySize) {
    res.writeHead(413, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "request body too large", max: prov.maxBodySize }));
  }

  // Collect body
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > prov.maxBodySize) {
      req.destroy();
      res.writeHead(413, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "request body too large", max: prov.maxBodySize }));
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const headers = { ...req.headers };

  // Retry loop
  const attempts = prov.maxRetries + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = prov.getNextKey();
    if (!key) {
      prov.recordAllKeysExhausted();
      sendAlert("all_keys_exhausted", `[${prov.name}] All ${prov.keys.length} keys are rate limited.`);
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "All keys rate limited", provider: prov.name }));
    }

    prov.recordRequest(key);

    try {
      const upstream = await prov.forward(key, req.method, proxyPath, headers, body);

      if (prov.retryableStatuses.includes(upstream.statusCode)) {
        upstream.resume();
        if (upstream.statusCode === 429) {
          prov.cooldownKey(key, upstream.headers["retry-after"]);
        }
        prov.cbRecordError();
        if (attempt < attempts - 1) continue;
        res.writeHead(upstream.statusCode, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `upstream returned ${upstream.statusCode}`, provider: prov.name }));
      }

      // Non-retryable response — record success only for 2xx/3xx
      if (upstream.statusCode < 400) {
        prov.cbRecordSuccess();
      } else {
        prov.cbRecordError();
      }
      const safeHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.statusCode, safeHeaders);
      const pipeTimeout = setTimeout(() => {
        console.error(`[keymux:${prov.name}] response pipe timeout — destroying upstream`);
        upstream.destroy();
        if (!res.writableEnded) res.end();
      }, prov.requestTimeout);
      upstream.on("end", () => clearTimeout(pipeTimeout));
      upstream.on("error", (err) => {
        clearTimeout(pipeTimeout);
        console.error(`[keymux:${prov.name}] upstream pipe error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });
      res.on("close", () => { clearTimeout(pipeTimeout); upstream.destroy(); });
      upstream.pipe(res);
      return;
    } catch (err) {
      console.error(`[keymux:${prov.name}] ${prov.keyId(key)} error: ${err.message}`);
      prov.recordError(key);
      prov.cbRecordError();
      if (attempt === attempts - 1) {
        res.writeHead(502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "upstream error", provider: prov.name }));
      }
    }
  }
}

// ── Request router ───────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  // Strip query string for route matching
  const reqPath = req.url.split("?")[0];

  // Global endpoints
  if (req.method === "GET" && reqPath === "/health") return handleHealth(req, res);
  if (req.method === "GET" && reqPath === "/stats") return handleStats(req, res);

  // List providers (requires PROXY_KEY)
  if (req.method === "GET" && reqPath === "/providers") {
    if (!checkAuth(req, PROXY_KEY)) return sendUnauthorized(res);
    const list = {};
    for (const [name, prov] of providers) {
      list[name] = { mode: prov.mode };
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ providers: list }));
  }

  // Parse /:provider/... from URL
  const match = req.url.match(/^\/([a-z0-9][a-z0-9_-]*)(\/.*)?$/);
  if (!match) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found", endpoints: ["/health", "/stats", "/providers", "/:provider/..."] }));
  }

  const providerName = match[1];
  const subPath = match[2] || "/";
  const prov = providers.get(providerName);

  if (!prov) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unknown provider" }));
  }

  // Rotation mode endpoints
  if (prov.mode === "rotation") {
    if (req.method === "GET" && subPath === "/key") return handleKeyRequest(req, res, prov);

    const cooldownMatch = subPath.match(/^\/key\/([^/]+)\/cooldown$/);
    if (req.method === "POST" && cooldownMatch) {
      return handleCooldownReport(req, res, prov, cooldownMatch[1]);
    }

    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      error: "not found",
      provider: prov.name,
      mode: "rotation",
      endpoints: [`/${prov.name}/key`, `/${prov.name}/key/:id/cooldown`],
    }));
  }

  // Proxy mode — forward subPath to upstream
  return handleProxy(req, res, prov, subPath);
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

// Global error handlers
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
  console.log(`[keymux] KeyMux on ${BIND_ADDRESS}:${PORT} with ${providers.size} provider(s)`);
  for (const [name, prov] of providers) {
    const ks = prov.keyStatus();
    console.log(`[keymux]   /${name} [${prov.mode}] ${ks.total} key(s)${prov.mode === "proxy" ? ` → ${prov.expectedHost}` : ""} (auth: ${prov.authScheme})`);
  }
  const hasRotation = [...providers.values()].some((p) => p.mode === "rotation");
  if (!PROXY_KEY && hasRotation) {
    console.error(`[keymux] FATAL: PROXY_KEY is required when any provider uses rotation mode (raw keys are exposed)`);
    process.exit(1);
  }
  if (!PROXY_KEY && !ADMIN_KEY) console.warn(`[keymux] WARNING: No PROXY_KEY or ADMIN_KEY set — endpoints are open to anyone with network access`);
  if (PROXY_KEY) console.log(`[keymux] Inbound auth: PROXY_KEY required`);
  if (EFFECTIVE_ADMIN_KEY) console.log(`[keymux] Admin auth: ${ADMIN_KEY ? "ADMIN_KEY" : "PROXY_KEY (fallback)"} required for /stats`);
  console.log(`[keymux] Stats: ${fs.existsSync(STATS_FILE) ? "loaded from disk" : "fresh start"}`);
});
