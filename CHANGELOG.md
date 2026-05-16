# Changelog

All notable changes to FFAI are documented in this file.

## hermes-plugin [0.3.0] - 2026-05-16

Workaround for a Hermes-side picker bug found while deploying 0.2.0
to a live VPS with 7 Hermes profiles. No server-side or openclaw-plugin
changes. 19/19 tests pass (added 2 regression tests).

### Fixes

- **`/model` picker showed `(0 models)` for every ffai-* entry** even
  when the FFAI bridge was healthy. Root cause: Hermes's
  `list_authenticated_providers` (`hermes_cli/model_switch.py` ~L1638)
  reads `entry["api_key"]` directly when grouping custom_providers for
  the picker and does NOT resolve `key_env` to a value there. Section 4
  of the picker then gates live model discovery on
  `if api_url and api_key:`, so an entry written with only `key_env:`
  is invisible in the count even though every other Hermes code path
  honours it.

  **`apply.js` now emits both `api_key:` (resolved from `FFAI_KEY` at
  install time) and `key_env: FFAI_KEY`.** This matches the shape
  Hermes's own `_save_custom_provider` (`main.py` L3313) writes when a
  user runs the setup wizard manually, so `/model` rendering is
  identical to the wizard-written path.

### Security note

The `FFAI_KEY` value now lands in `config.yaml` (chmod 600) in
addition to `~/.hermes/.env`. Both files have the same single-user
0600 boundary, so this is consistent with Hermes's own conventions —
no new exposure. `key_env:` is preserved on every entry so:

- Operators inspecting the file see the source of truth.
- Future rotations via `ffai-hermes install` correctly identify
  ffai-* entries to update.
- If Hermes ever fixes the section-4 picker to honour `key_env:`,
  the file already declares it — no migration needed.

### API

- `applyCustomProviders(doc, providers, baseUrl, opts)` now accepts an
  optional `opts.apiKey` parameter. When non-empty, it's embedded as
  `api_key:` on every emitted entry. Blank/whitespace values are
  ignored (no `api_key: ""` written, which would be worse than
  omitting it).
- `sync.js` and `install.js` pass the resolved `FFAI_KEY` through to
  this option transparently.

## hermes-plugin [0.2.0] - 2026-05-15

Hardening pass on the freshly-landed hermes-plugin, mirroring the
patterns already applied to openclaw-plugin in 0.6.0. No FFAI server
changes. 17/17 tests pass.

### Security

- **SSRF guard on `discoverProviders`.** Base URL is validated up
  front (`http(s)` only, no credentials, no query/hash) and cloud
  metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
  `fd00:ec2::*`) are refused even when reached via a CNAME. Running
  the CLI on a cloud VM with a hijacked FFAI bridge can no longer be
  turned into an IMDS-credential exfiltration tool.
- **Bounded response body** (10 MB) on `/models` via streaming
  reader. Stops OOM-via-giant-payload from a malicious FFAI server.
- **Env-line injection guard.** `upsertEnvKey` rejects values
  containing `\n`, `\r`, or NUL — without this, a key with a
  newline could inject a second `KEY=value` line under attacker
  control (`FFAI_KEY=safe\nANTHROPIC_API_KEY=stolen`).
- **Cross-process lock on `.env` writes.** Previously only
  `config.yaml` was lock-protected; concurrent `ffai-hermes install`
  invocations could race the env write.

### Reliability

- **Provider-name collision handled.** Two FFAI providers that
  sanitize to the same custom_providers `name` (e.g. `Groq!` and
  `groq?`) now get a numeric disambiguator (`ffai-groq`,
  `ffai-groq-2`) with their own `base_url`, instead of silently
  clobbering each other on YAML upsert. Mirrors the openclaw-plugin
  `provider-catalog.ts` fix in 0.6.0. Collisions are surfaced as
  warnings in the CLI output.
- **Stable-key change detection** in `upsertCustomProvider`. The
  prior `JSON.stringify` compare was key-order-sensitive, so a
  re-upsert where YAML happened to have keys in a different order
  than the entry would report `"updated"` even when the data was
  identical.

### CLI ergonomics

- **`--name=VALUE` form** accepted alongside `--name VALUE` for all
  flags.
- **`--version` / `-v`** flag prints the package version.
- **`--timeout MS`** flag (and plumbed through to discovery) lets
  operators raise the 15s default for slow networks. Capped at
  120000 ms so a typo can't hang CI forever.

## [0.6.0] - 2026-04-26

Plugin hardening pass driven by an internal multi-agent code review.
Plugin companion bump: `1.4.0`. No server-side behaviour change — all
fixes are inside `openclaw-plugin/`.

### Security

- **Pin port + scheme in outbound FFAI requests.** The SDK SSRF policy
  is hostname-only; a tampered `baseUrl` could otherwise pivot from
  `127.0.0.1:8010` to `127.0.0.1:22`. New `buildFfaiEndpointUrl`
  rejects non-http(s) schemes, embedded credentials, and query/hash,
  and composes URLs explicitly so a path can't be smuggled through
  string concatenation.
- **Cap response body size at 10 MB.** Streaming bounded reader on
  `/models` responses prevents a malicious or misconfigured FFAI
  server from OOM-ing the gateway at boot.
- **Redact and sanitize all server-supplied strings before echoing to
  channels.** `/import`'s `message`, `restart_hint`, and `provider`
  fields go through `redactSecrets` (now also catches `?api_key=`,
  `?token=` query-string credentials) and a strict charset filter
  before being interpolated into Telegram/Discord output. Closes a
  channel-rendering injection vector (a server-controlled provider
  name like `[click](http://attacker)` would otherwise become a
  clickable link).
- **Bound `/ffai_import_keys` blob size and validate charset.** 64 KB
  cap and `^FFAI-IMPORT:[A-Za-z0-9+/=._-]+$` regex stop hostile pasted
  blobs from consuming memory or smuggling JSON-injection bytes
  before the FFAI server gets to reject them.
- **Drop key-length disclosure from `/ffai_doctor`.** Reporting
  `present (39 chars)` is a small side-channel that helps an attacker
  distinguish key formats; now reports just `present`.

### Reliability

- **Cross-process file lock around `openclaw.json` writes.** New
  `withConfigLock` (mkdir-mutex + 60s stale-detection) wraps the full
  read-modify-write cycle. Without this, gateway + `openclaw configure`
  running concurrently could interleave and silently drop one writer's
  changes.
- **Atomic write hardened.** UUID tmp suffix (no PID-reuse collisions
  or leftover tmps from prior processes), `fsync` before rename (no
  zero-byte file published on power loss), finally-unlink on any
  failure path.
- **`runCatalogSync` body wrapped in try/finally** so an early throw
  never leaves the `inFlight` flag stuck and blocks future syncs.
- **Sync flags promoted to `globalThis[Symbol.for(...)]`** so plugin
  hot-reload (which clears module-level bindings) doesn't cause
  duplicate sync runs on the same gateway process.
- **IPv6 Tailscale ULA detection.** `findTailscaleIp` now recognises
  the `fd7a:115c:a1e0::/48` ULA range and brackets IPv6 hosts in
  generated URLs (`[fd7a::1]:8010`), unblocking IPv6-only Tailnets.
- **`/health` probe accepts any status <500.** FFAI deployments
  without a `/health` endpoint no longer silently fail Tailscale
  auto-flip — connectivity is what we're probing, not application
  health.
- **Stable-key `JSON.stringify` for change detection.** Eliminates
  spurious writes when a rebuilt providers map is structurally equal
  but has different key insertion order than the on-disk version.

### Plugin code quality

- **Catalog hook fully wrapped in try/catch.** Every helper called
  from `runFfaiCatalog` operates on `unknown`-shaped config from
  disk; a single TypeError must not propagate out and break OpenClaw
  boot. Override models are validated to be objects-with-string-id
  before publishing.
- **Provider-key collisions get a numeric disambiguator.** Two FFAI
  providers that sanitize to the same key (e.g. `Groq!` and `groq?`)
  used to merge into the first provider's URL, silently 404-ing the
  second provider's models. Now becomes `ffai-groq` and `ffai-groq-2`,
  each with the correct upstream URL.
- **Model-id dedup within each discovered group** — FFAI sometimes
  echoes the same model under multiple aliases; OpenClaw routes by
  id so duplicates were noise at best, non-deterministic at worst.
- **AbortController + clearTimeout** replaces `AbortSignal.timeout`
  everywhere so the abort timer doesn't outlive the response read.
- **`probeTimeoutMs` configurable** from plugin config (capped 30s)
  for cross-continent Tailnets where RTT exceeds the 2s default.
- **catalog-sync rejection logs via `api.logger.error`** instead of
  being swallowed as `.catch(() => {})`.

### Docs (plugin)

- README check-counts corrected (9 typical, 11 with Discord — was
  8/10), "four slash commands" (was "three"), `FFAI_BIND` row added
  to the env table with link to canonical Tailscale section, stale
  "pre-1.2.0" cutoff removed from the legacy-alias note.
- AGENTS.md doctor-check count corrected.
- `docs/adding-a-provider.md` cross-link to repo-root AGENTS.md fixed
  (`../../AGENTS.md`), `serve.js` line-number references replaced
  with symbol-name anchors that won't rot when the file is reorganised.

### package.json + tsconfig

- Dropped `main: ./index.ts` (Node can't load TS directly; the host
  loads the plugin via `openclaw.plugin.json`).
- `noUnusedParameters: true` (was `false`), now consistent with
  `noUnusedLocals`.

## [0.5.0] - 2026-04-26

Reliability and onboarding pass after operator feedback. Plugin
companion bump: `1.3.0`.

### Fixes (server)

- **Stop promoting env-sourced keys to plaintext config on `/import`**
  — pre-0.5.0, importing a key for a provider that used `keys_var`
  copied the entire env-sourced key list into `provConf.keys` on disk,
  which silently disabled future env updates. Now `resolveKeys()`
  union-merges both sources and `/import` only writes the new keys.
  Two regression tests added.
- **`compat-sync` → `catalog-sync` rename, drop heartbeat code, add
  backoff retry.** The native `providerDiscoveryEntry` dispatch path
  doesn't fire for plugins that combine catalog discovery with a
  runtime entry that registers commands — the upstream tracking issue
  closed without addressing this. Catalog publication is now the
  documented mechanism, not a workaround. Backoff retry (5s..120s..
  120s, ~5min budget) handles the gateway-races-FFAI-startup case.
- **Auto-create provider stanzas on `/import`** — for the five known
  providers (Gemini, Groq, Cerebras, Ollama, SambaNova), an import for
  a provider not yet in `config.json` creates the stanza from a
  built-in `PROVIDER_TEMPLATES` entry instead of returning the old
  "unknown provider" error.

### New features (server)

- **Tailscale auto-flip in catalog-sync** — when no operator override
  is set and the resolved baseUrl is loopback, catalog-sync detects a
  Tailscale interface (`100.64.0.0/10` CGNAT), probes
  `http://<tailscale-ip>:<port>/health`, and publishes the Tailscale
  URL to `openclaw.json` if the probe succeeds. Workaround for
  OpenClaw's Discord loopback filter (openclaw#35516, closed/stale)
  that hides loopback providers from Discord's `/models` picker.
  Probe-before-flip ensures we never break the gateway-to-FFAI path
  — if FFAI is bound to loopback only, the probe fails and we keep
  loopback. To enable: set `FFAI_BIND=0.0.0.0` in FFAI's environment.
- **Sharper error messages on env-not-visible-to-gateway** — `/ffai_stats`
  and `/ffai_encrypt` now distinguish "env var unset" from "set but
  the gateway was started before the change" and explicitly tell the
  operator to restart the gateway, then run `/ffai_doctor` to verify.
- **`/import` response carries `restart_hint`** that the plugin
  surfaces in chat ("if discovery doesn't show the new keys within
  ~30s, restart FFAI"). Keys are persisted to `config.json` even when
  hot-reload is best-effort, so a restart always picks them up.

### New features (plugin)

- **`/ffai_doctor` slash command** — eight-to-ten preflight checks
  covering plugin loaded, gateway env, FFAI reachability, providers
  configured, keys present, /models populated, openclaw.json
  catalog-sync, allowlist coverage, and (when applicable)
  Discord/loopback compatibility + Tailscale auto-flip status. Each
  failing line carries a one-sentence remediation.
- **Plugin-side mismatch reporting** — `/ffai_import_keys` chat output
  now distinguishes `imported`, `duplicates`, `invalid`, and
  `mismatched` counts.

### Documentation

- New top-level [`AGENTS.md`](AGENTS.md) and
  [`openclaw-plugin/AGENTS.md`](openclaw-plugin/AGENTS.md) for AI
  agents working in the codebase or in OpenClaw runtime contexts.
- New "Tailscale setup (required for Discord)" section in the plugin
  README — six numbered steps end-to-end. Every other Tailscale
  reference in the repo points at this section instead of restating.
- Plugin README FAQ section answering common gotchas (gateway env
  visibility, key persistence, hot-reload, format mismatch, context
  windows, FFAI_KEY vs FFAI_ADMIN_KEY, `/models` empty in Discord).
- Plugin Quick Install rewritten as eight numbered steps with
  `/ffai_doctor` as the verification step.
- New developer guide at [`openclaw-plugin/docs/adding-a-provider.md`](openclaw-plugin/docs/adding-a-provider.md)
  covering the 4-file checklist for adding a new OpenAI-compatible
  provider.

### Breaking changes

- **None.** Plugin config still accepts `compatSync: false` as an
  alias for `catalogSync: false`. v1 import blobs (pre-0.4.0
  shared-secret crypto) still work within their 24h TTL window.

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
