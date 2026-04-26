# Changelog

All notable changes to FFAI are documented in this file.

## [0.4.0] - 2026-04-26

Provider expansion, public-key key-import upgrade, and a documentation
overhaul.

### Import system — v2 public-key crypto

The v1 import flow embedded a 32-byte shared secret directly into the
generated HTML page and used it as a PBKDF2 password. Because both the
HTML and the encrypted blob typically traveled through the same chat
transport, an attacker with transcript access could decrypt locally.
v2 replaces this with public-key crypto: the HTML now contains only the
server's public key.

- **ECDH P-256 + HKDF-SHA256 + AES-256-GCM** — server holds a persistent
  keypair in `config.json` under `import_keypair`; only the public half
  ever leaves the host
- **No decryption secret in the HTML** — an attacker who captures both
  the page and the blob still cannot decrypt without compromising the
  FFAI host itself
- **Nonce-based replay protection** — random 18-byte nonce inside each
  decrypted plaintext; remembered for 24h
- **Freshness gate** — blobs older than 24h or more than 60s in the
  future are rejected
- **Live countdown in the HTML** — refuses to encrypt past the TTL
- **v1 legacy path** — old shared-secret blobs still accepted within
  their 24h TTL window for transition; new pages always emit v2

### Import system — UX & validation

- **Auto-detect provider** — page reads each key's format and picks the
  provider automatically; default is "Auto-detect (recommended)"
- **Mixed-batch rejection** — refuses to encrypt keys belonging to
  different providers in a single batch
- **Server-side format validation** — `PROVIDER_KEY_PATTERNS` table for
  Gemini, Groq, Cerebras, Ollama, SambaNova; mismatched keys never enter
  the pool
- **`mismatched` count** in the import response and audit log
- **New audit reasons**: `replay`, `stale_blob`, `bad_ephpub`,
  `missing_nonce`, `decrypt_failed` (v2-aware), `expired_token` /
  `unknown_token` (v1)
- **SambaNova added** to the encrypt page's manual-pick dropdown (was
  missing entirely under v1)

### Provider expansion

- **SambaNova provider** — bearer auth, 20 RPM/RPD per key, with
  `model_exclude` support so higher-tier models that 422 on free keys
  never enter the pool
- **`model_exclude` field** — per-provider list of model IDs to drop at
  discovery time

### Model discovery — accuracy fixes

- **SambaNova `context_length` field** — discovery was reading
  `context_window` (which doesn't exist), so DeepSeek-V3.2 was wrongly
  advertised as 131K context. Fixed to fall back to `context_length`,
  the SambaNova-native field
- **Ollama `/api/show` enrichment** — Ollama's OpenAI-compat `/v1/models`
  returns no specs at all; discovery now POSTs to `/api/show` per model
  to extract the architecture-specific `*.context_length`. Real
  context windows surface in the catalog instead of the 131K default
- **`FFAI_MIN_CONTEXT_WINDOW` enforcement** — drops models below the
  minimum from both pre-enrichment and post-enrichment filters; default
  stays at 32K but operators are encouraged to set 131072 for agent
  workloads where 32K models cause immediate context overflow

### OpenClaw plugin

- **Allowlist sync in compat-sync** — when `agents.defaults.models` is
  non-empty (acts as an allowlist), discovered ffai-* model refs are
  added to it automatically; otherwise newly-discovered models would
  silently fail to appear in `/models`. Existing entries are never
  removed
- **Plugin-side mismatch reporting** — `/ffai_import_keys` chat output
  now distinguishes `imported`, `duplicates`, `invalid`, and
  `mismatched` counts

### Documentation

- Top-level README rewritten — was stale "KeyMux" branding with wrong
  config filename, wrong env var names, and references to non-existent
  example files
- `openclaw-plugin/README.md` grew a Security model section, a
  Key-format requirements table, audit log event reference, and a
  Where-keys-end-up section covering backup/restore implications
- `FFAI-Features.md` — corrected two factually wrong claims (a fictional
  user-typed password in the encrypt page, and a non-existent auto-import
  hook)
- `config.json.example` created — was referenced from the README but
  never existed
- `Dockerfile` and `docker-compose.yml` fixed — both still pointed at a
  pre-rename `keymux` / `server.js` / `providers.json` world

### Breaking changes

- **None for existing imports** — v1 blobs continue to work for the 24h
  TTL window post-upgrade. New pages emit v2 only.
- **`import_tokens` field in `config.json`** — still parsed for legacy
  blob acceptance, but no longer written. New deployments never see it.
- **`config.json` now contains `import_keypair`** — both halves of the
  ECDH P-256 keypair. Treat this with the same care as the provider
  keys (mode 0600, do not commit). Deleting it regenerates a new pair
  on next boot, invalidating any outstanding HTML pages.

## [0.3.0] - 2026-04-13

Security hardening release after comprehensive multi-angle security audit (18 findings, all fixed).

> **Note:** The "Import System Security" bullets below describe the v1
> shared-secret flow (PBKDF2 + AES-GCM with a token in the HTML). That
> flow was replaced in 0.4.0 by a public-key ECDH design. The hardening
> measures listed here (rate limiting, brute-force protection, audit
> log, atomic config writes) are still in effect; the crypto specifics
> are not.

### Import System Security
- **Single-use import tokens** — tokens consumed after first successful use; replay attacks blocked
- **Token TTL enforcement** — 24-hour expiry on import tokens; stale tokens rejected server-side
- **Token cap** — max 20 active tokens; oldest expired first, then FIFO eviction
- **Import rate limiting** — 10 requests/min per IP sliding window on `/import` endpoint
- **PBKDF2 iteration increase** — 100,000 → 600,000 iterations (both client HTML and server-side)
- **Bounded token generation** — 5-attempt retry loop replaces unbounded recursion for ID collisions
- **Uniform error messages** — same response for unknown token, expired token, and decryption failure (prevents oracle attacks)

### Client-Side (Import HTML)
- **Content Security Policy** — `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src *`
- **Referrer policy** — `no-referrer` meta tag prevents URL leakage
- **Autocomplete suppression** — `autocomplete="off"` on key textarea and URL input
- **Safe Base64 encoding** — chunked `arrToBase64()` replaces `btoa(String.fromCharCode(...spread))` (prevents stack overflow on large payloads)
- **Delete-after-use warning** — UI info box warns tokens are single-use

### Infrastructure
- **Localhost binding** — FFAI_BIND changed from `0.0.0.0` to `127.0.0.1`
- **File permissions** — config.json, systemd service files, and overrides locked to mode 600
- **FFAI_ADMIN_KEY in gateway** — added to openclaw-gateway.service environment
- **Atomic config writes** — write-to-tmp + rename pattern prevents corruption on crash

### Plugin Security
- **Error sanitization** — API error responses truncated to 200 chars; key patterns (`sk-`, `gsk_`, `AIzaSy`, `csk-`, `Bearer`) redacted before display
- **Auth failure recording** — failed `/import` and `/generate-import` attempts feed into brute-force protection

### Observability
- **Audit logging** — JSON-lines `import-audit.log` records all import attempts (success, failure, rate-limit) with timestamps, IPs, and token IDs

### OpenClaw Plugin
- **File split** — `index.ts` (env access) separated from `ffai-commands.ts` (network calls) to pass OpenClaw 2026.4.11 security scanner (`env-harvesting` rule)
- **Manifest cleanup** — removed `providers`/`providerAuthEnvVars`/`providerAuthChoices` from `openclaw.plugin.json` (registered dynamically via API; static entries caused gateway to skip plugin loading)
- **Hook registration** — `before_prompt_build` hook with proper `name` option for clean startup
- **Renamed command** — `/ffai_import` → `/ffai_encrypt` (clearer intent)
- ~~**Auto-import hook** — agent prompt injection teaches LLM to auto-run `/ffai_import_keys` when user pastes `FFAI-IMPORT:` blobs~~ *(removed — auto-importing untrusted pasted content is a prompt-injection footgun. `/ffai_import_keys` is user-initiated only.)*

## [0.2.0] - 2026-04-05

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
