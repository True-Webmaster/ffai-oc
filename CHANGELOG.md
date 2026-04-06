# Changelog

All notable changes to KeyMux are documented in this file.

## [1.0.0] - 2026-04-05

Production-hardened release after comprehensive 5-lens QC audit (Security, Code Review, Chaos Engineering, Debugging, Error Detection, PR Review, Architecture).

### Security
- **Header allowlist** — replaced blocklist with strict allowlists for both outbound request headers (`FORWARD_REQUEST_HEADERS`) and response headers (`FORWARD_RESPONSE_HEADERS`); all unlisted headers are stripped
- **Path traversal protection** — three-layer defense: raw check, `decodeURIComponent` check (blocks `%252e%252e` double-encoding), and post-construction `url.pathname` verification
- **Timing-safe auth** — `crypto.timingSafeEqual` for PROXY_KEY and ADMIN_KEY comparison with byte-length pre-check
- **Auth brute-force protection** — per-IP rate limiting (10 failures/min = 5min block) with stale-first eviction and 100K entry cap
- **HTTPS enforcement** — `sync-models.js` requires HTTPS for non-loopback KEYMUX_URL
- **Gemini API key transport** — uses `x-goog-api-key` header instead of query parameter for native API calls
- **Log scrubbing** — API keys shown as `...xxxx` suffixes in all log output
- **Admin isolation** — ADMIN_KEY separated from PROXY_KEY; /stats and /health details require ADMIN_KEY
- **.env permissions** — `sync-all.sh` enforces mode 600 (hard gate, not warning)
- **Whitespace-only PROXY_KEY** — fatal exit if set but empty after trim
- **Env var whitelist** — `sync-all.sh` only exports specific allowed keys from .env

### Smart Scoring
- **Intelligent key selection** — scores by RPM/TPM/RPD usage ratios, cooldown proximity, error history, and recency
- **Adaptive RPM learning** — discovers actual rate limits from 429 Retry-After and adjusts scoring
- **Per-key circuit breakers** — individual keys tripped after consecutive errors (default: 3 = 2min cooldown)
- **TOCTOU fix** — `lastUsed` set immediately in `selectKey()` to prevent concurrent requests picking the same key
- **Cooldown/CB separation** — `anyKeyAvailable` flag prevents infinite retry loops when all keys are in cooldown but not CB-tripped

### Reliability
- **Exponential retry backoff** — `min(100 * 2^attempt, 2000)` in both retryable-status and catch blocks
- **Body reset on retry** — original body saved before sanitizer, restored before each retry attempt (prevents thought signature mutation degradation)
- **SSE extended timeout** — streaming responses get `max(requestTimeout * 3, 360s)` (minimum 6 minutes)
- **Pipe timeout flag** — `pipeTimedOut` guards `res.write()` after timeout/close to prevent ERR_STREAM_WRITE_AFTER_END
- **Circuit breaker episode tracking** — `_cbEpisodeActive` flag prevents alert spam during key flapping
- **Alert throttling** — max 1 webhook per event type per 60 seconds
- **Oversized body handling** — `req.resume()` instead of `req.destroy()` in for-await loop (prevents ERR_HTTP_HEADERS_SENT)
- **fetchModels body cap** — 10MB limit on model list responses
- **Per-provider /models timeout** — 10s `Promise.race` per provider with `Promise.allSettled` for graceful degradation
- **Retry-After HTTP-date** — `Date.parse` fallback for RFC 2616 date format

### Observability
- **Request correlation ID** — 8-char hex ID (`crypto.randomBytes(4)`) in all handleProxy logs and `x-request-id` response header
- **X-KeyMux-Modified header** — present when request body was sanitized
- **Rotation audit trail** — vended keys logged with correlation ID and client IP
- **Stack traces** — `err.stack` in all error handlers (unhandledRejection, uncaughtException, top-level catch)
- **400 error forwarding** — sanitized upstream error body forwarded to client (type + message only)
- **SSE parse failure counting** — logs summary of JSON parse errors per streaming response
- **Alert webhook logging** — timeout and non-2xx responses logged
- **Ambiguous key fragment rejection** — cooldown endpoint returns 400 if suffix matches multiple keys

### Architecture
- **Async stats flush** — `fs.promises.writeFile` for periodic persistence (no longer blocks event loop); sync fallback for shutdown/crash only
- **SSE connection tracking** — active connections tracked in Set; `data: [DONE]\n\n` sent on graceful shutdown
- **Stale-first auth eviction** — expired blocks and old windows evicted before FIFO fallback
- **Default paths** — `STATS_FILE` and `PROVIDERS_FILE` use `__dirname` instead of cwd-relative paths
- **Atomic dual-write** — `sync-models.js` writes both `.tmp` files before renaming either (minimizes partial-update window)
- **Wipe protection** — sync aborts if all keymux providers end up with 0 models
- **Lock file location** — `sync-all.sh` lock moved to `$KEYMUX_DIR/.sync.lock` (not `/tmp`, prevents symlink-race)

### OpenClaw Integration
- **Programmatic model filtering** — pattern-based rules: MIN_CONTEXT_WINDOW=8192, MIN_OUTPUT_TOKENS=4096, MIN_PARAM_BILLIONS=4
- **Versioned model dedup** — skips `model-001` when `model` exists
- **Alias filtering** — skips models ending in `-latest` (pointer aliases)
- **Thought signature cache** — 500-entry LRU with 5min TTL for Gemini 3 tool calling
- **Thought signature compaction** — unsigned tool calls compacted to text (prevents Gemini rejection)
- **Nullish coalescing** — `??` for spec resolution (preserves `0` values from APIs)
- **Empty provider cleanup** — removes provider entries when all models filtered out
- **openclaw.json exit code** — non-zero exit on write failure (prevents split-brain)
- **Native spec timeout** — 30s aggregate deadline for all native API spec fetches
- **Corrupt models.json recovery** — detects, backs up, and recreates from fresh

### sync-all.sh
- **Exclusive flock** — prevents concurrent instances
- **Printf-based parsing** — `printf '%s'` instead of `echo` (no backslash mangling)
- **.env permissions hard gate** — exits 1 on non-600 mode
- **Timeout command guard** — graceful fallback if `timeout` unavailable
- **Per-agent timeout** — 30s per agent with timeout vs error distinction
- **Empty PROXY_KEY warning** — logs if auth key is empty after sourcing
- **Per-agent log markers** — agent name extracted and logged for attribution

## [0.1.0] - 2026-04-04

Initial release.

### Added
- Multi-provider architecture with `providers.json` configuration
- Proxy mode (full gateway) and rotation mode (key dispenser)
- Key rotation with round-robin and rate-limit cooldowns
- Provider-agnostic auth schemes (bearer, header, query, none)
- Provider-level circuit breaker
- Stats persistence with daily history
- Alert webhook for key exhaustion and circuit breaks
- Health check and stats endpoints
- Docker and Docker Compose support
- OpenClaw model sync (`sync-models.js`, `sync-all.sh`)
- Gemini 3 thought signature handling
- Request body sanitization for OpenAI-compat endpoints
