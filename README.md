# FFAI — Free Freaking AI

Zero-dependency, key-pooling proxy for OpenAI-compatible LLM APIs. Pool
keys across multiple providers (Gemini, Groq, Cerebras, Ollama,
SambaNova — anything OpenAI-compatible), get free-tier capacity rotated
across keys, and surface the unified catalog to OpenClaw via the
first-party plugin in `openclaw-plugin/`.

## Features

### Core
- **Multi-provider** — define providers in `config.json`, each with independent keys, rate limits, and circuit breakers
- **Path-based routing** — `/{provider}/v1/...` dispatches to the correct upstream
- **Auto-routing** — `/v1/chat/completions` picks the provider based on the requested model
- **Smart key selection** — scores keys by RPM/TPM/RPD usage, cooldown proximity, error history, and recency
- **Adaptive rate-limit learning** — discovers actual provider RPM from 429 responses
- **Streaming** — pipes upstream SSE/chunked responses with extended timeouts
- **Hot reload** — `SIGHUP` reloads `config.json` without dropping live connections
- **Graceful shutdown** — drains active SSE connections on SIGTERM/SIGINT

### Model discovery
- **Dynamic catalog** — periodically queries each provider's `/v1/models` and builds a unified list
- **Native spec enrichment** — Gemini specs from `generativelanguage.googleapis.com`, Ollama context windows from `/api/show`, SambaNova from `context_length`
- **Filtering** — drops models below `FFAI_MIN_CONTEXT_WINDOW`, `FFAI_MIN_TPM`, and `FFAI_MIN_PARAM_BILLIONS` so the catalog only shows agent-usable models

### Security
- **Encrypted key import** — paste an encrypted blob in chat, FFAI decrypts with its private key. ECDH P-256 + HKDF-SHA256 + AES-256-GCM. The HTML page contains no decryption secret. See [`openclaw-plugin/README.md`](openclaw-plugin/README.md#security-model).
- **Per-provider key-format validation** — mismatched keys are rejected at import time, never silently trip circuit breakers
- **Header allowlist** — strict allowlists for both outbound request and inbound response headers
- **Path traversal protection** — three-layer check (raw, decoded, post-resolution)
- **SSRF protection** — hostname validation on all constructed upstream URLs
- **Auth brute-force protection** — per-IP rate limiting (10 failures/min = 5min block) with stale-first eviction
- **Body size limits** — configurable per-provider, enforced pre-read and during streaming
- **Body sanitization** — strips non-standard OpenAI params, normalizes `max_completion_tokens`, caps `max_tokens` per provider
- **Log scrubbing** — API keys never appear in logs (shown as `...xxxx` suffixes)
- **Timing-safe auth** — constant-time comparison for `FFAI_KEY` and `FFAI_ADMIN_KEY`

### Reliability
- **Provider-level circuit breaker** — auto-disable on repeated errors, alert webhook fires on trip
- **Per-key circuit breaker** — individual keys isolated on consecutive failures, others keep serving
- **Exponential retry backoff** — 100ms → 200ms → 400ms, capped at 2s, with body reset between retries
- **Rate-limit handling** — respects `Retry-After` (seconds and HTTP-date formats)
- **Wipe protection** — discovery never overwrites the live catalog with empty/error results
- **Async stats persistence** — non-blocking writes with atomic rename

### OpenClaw integration
- **First-party plugin** in `openclaw-plugin/` — registers FFAI as an OpenClaw provider, discovers the model catalog dynamically, and ships three slash commands (`/ffai_stats`, `/ffai_encrypt`, `/ffai_import_keys`). See the plugin's [README](openclaw-plugin/README.md) for install and configuration.

## Quick start

```bash
# 1. Create your provider config
cp config.json.example config.json
#    Edit config.json — define providers and rate limits

# 2. Create your environment
cp .env.example .env
chmod 600 .env       # .env holds API keys
#    Edit .env — set FFAI_KEY and your provider key vars (GEMINI_KEYS, GROQ_KEYS, …)

# 3. Run
node serve.js
```

Default port is `8010`, default bind is `127.0.0.1`. To talk to FFAI from
elsewhere on the network, set `FFAI_BIND=0.0.0.0` (and **definitely** set
`FFAI_KEY` first — without it, anyone reachable can use your keys).

## Docker

```bash
cp config.json.example config.json
cp .env.example .env
chmod 600 .env
# Edit both files

docker compose up -d
```

The container binds internally to `0.0.0.0:8010`. The compose setup
publishes that to `127.0.0.1:${FFAI_PORT:-8010}` on the host (loopback
only) — change `docker-compose.yml` if you want it reachable from outside.

## Architecture

```
Client -> POST /v1/chat/completions          -> FFAI auto-routes by model -> upstream
Client -> POST /gemini/v1/chat/completions   -> FFAI key-rotates Gemini keys
Client -> GET  /models                       -> Unified catalog from all providers
Client -> GET  /savings                      -> Cost-avoided stats
```

Each provider in `config.json` gets its own:
- Key pool with smart scoring
- Auth scheme (bearer, header, or query)
- Rate-limit budget (RPM/TPM/RPD)
- Circuit breaker (per-key and per-provider)
- Stats tracking (per-key, per-day)
- Optional model exclusion list (`model_exclude`)

### Request flow (proxy mode)

1. Client POSTs to `/v1/chat/completions` (auto-route) or `/{provider}/v1/...` (explicit)
2. Auth check (`FFAI_KEY`, brute-force protection)
3. Path validation (traversal, allowed paths)
4. Body collection with size limit
5. Body sanitization (strip non-standard params, normalize/cap tokens)
6. Smart key selection
7. Forward to upstream with allowlisted headers
8. On retryable error: backoff, reset body, try next key
9. Stream response back with allowlisted headers + correlation ID

## Configuration

### `config.json`

Define providers and their keys/limits. The full field list lives in
[`lib/config-validator.js`](lib/config-validator.js). Common fields:

```json
{
  "favorites": ["gemini-2.5-pro", "qwen3-coder:480b"],
  "providers": {
    "gemini": {
      "keys_var": "GEMINI_KEYS",
      "upstream_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "auth_scheme": "bearer",
      "rpm_limit": 15,
      "tpm_limit": 1000000,
      "rpd_limit": 1500,
      "default_cooldown": 10,
      "max_cooldown": 300,
      "retryable_statuses": [429, 502, 503],
      "key_cb_threshold": 5,
      "key_cb_cooldown": 120000
    }
  }
}
```

| Field                | Default                | Description                                                              |
|----------------------|------------------------|--------------------------------------------------------------------------|
| `upstream_url`       | *(required)*           | Upstream API base URL                                                    |
| `keys`               | —                      | Array of API keys (alternative to `keys_var`)                            |
| `keys_var`           | —                      | Env var name holding comma-separated keys                                |
| `auth_scheme`        | `bearer`               | `bearer`, `header`, or `query`                                           |
| `auth_header`        | `authorization`        | Header name when `auth_scheme: "header"`                                 |
| `auth_query`         | `key`                  | Query param name when `auth_scheme: "query"`                             |
| `rpm_limit`          | `0` (off)              | Requests per minute per key (enables smart scoring)                      |
| `tpm_limit`          | `0` (off)              | Tokens per minute per key                                                |
| `rpd_limit`          | `0` (off)              | Requests per day per key                                                 |
| `tpd_limit`          | `0` (off)              | Tokens per day per key                                                   |
| `max_concurrent`     | unlimited              | Max in-flight requests per provider                                      |
| `acquire_wait_ms`    | `3000`                 | How long to wait for a free key before 503                               |
| `request_timeout`    | `120000`               | Upstream request timeout (ms)                                            |
| `key_cb_threshold`   | `3`                    | Consecutive errors to trip per-key CB                                    |
| `key_cb_cooldown`    | `120000`               | Per-key CB cooldown (ms)                                                 |
| `default_cooldown`   | `60`                   | Cooldown seconds when no `Retry-After` header                            |
| `max_cooldown`       | `300`                  | Maximum cooldown seconds                                                 |
| `retryable_statuses` | `[429, 502, 503]`      | HTTP status codes that trigger retry                                     |
| `models`             | —                      | Static model list (otherwise discovered dynamically)                     |
| `model_aliases`      | —                      | Map of `alias → real_id` for incoming requests                           |
| `model_exclude`      | `[]`                   | Model IDs to drop from discovery output (e.g. higher-tier models)        |

A complete starter config is in [`config.json.example`](config.json.example).

### Environment variables (`.env`)

Global runtime knobs. Because `.env` holds API keys, `chmod 600 .env`
before starting the server.

| Variable                     | Default                     | Description                                                              |
|------------------------------|-----------------------------|--------------------------------------------------------------------------|
| `FFAI_PORT`                  | `8010` (also reads `PORT`)  | Listen port                                                              |
| `FFAI_BIND`                  | `127.0.0.1`                 | Bind address (`0.0.0.0` in Docker)                                       |
| `FFAI_KEY`                   | —                           | Shared secret clients send as `Authorization: Bearer <FFAI_KEY>`         |
| `FFAI_ADMIN_KEY`             | falls back to `FFAI_KEY`    | Required for `/stats`, `/savings`, `/providers`, `/smush`, `/generate-import` |
| `FFAI_CONFIG`                | `./config.json`             | Path to provider config                                                  |
| `FFAI_STATS_FILE`            | `./data/stats.json`         | Stats persistence path                                                   |
| `FFAI_STATS_RETENTION_DAYS`  | `7`                         | Days of stats history                                                    |
| `FFAI_STATS_FLUSH_INTERVAL`  | `60000`                     | Stats write interval (ms)                                                |
| `FFAI_REQUEST_TIMEOUT`       | `120000`                    | Default upstream request timeout (ms)                                    |
| `FFAI_MAX_BODY_SIZE`         | `2097152`                   | Default max request body (2 MB)                                          |
| `FFAI_ACQUIRE_WAIT_MS`       | `3000`                      | Default key-acquire wait before 503                                      |
| `FFAI_DRAIN_TIMEOUT`         | `10000`                     | Graceful-shutdown drain window (ms)                                      |
| `FFAI_DISCOVERY_TIMEOUT`     | `30000`                     | `/v1/models` discovery wall timeout                                      |
| `FFAI_DISCOVERY_SOCKET_TIMEOUT` | `15000`                  | Discovery socket-idle timeout                                            |
| `FFAI_DISCOVERY_SPEC_TIMEOUT`| `30000`                     | Native-spec fetch budget (Gemini, Ollama)                                |
| `FFAI_MIN_CONTEXT_WINDOW`    | `32768`                     | Drop discovered models below this context size                           |
| `FFAI_MIN_OUTPUT_TOKENS`     | `4096`                      | Drop discovered models below this output cap                             |
| `FFAI_MIN_PARAM_BILLIONS`    | `4`                         | Drop discovered models smaller than N billion params                     |
| `FFAI_MIN_TPM`               | `20000`                     | Drop providers whose TPM is below this                                   |
| `FFAI_AUTH_FAIL_MAX`         | `10`                        | Max auth failures per IP before block                                    |
| `FFAI_AUTH_FAIL_WINDOW`      | `60000`                     | Failure-counting window (ms)                                             |
| `FFAI_AUTH_BLOCK_DURATION`   | `300000`                    | Block duration after too many failures (ms)                              |
| `FFAI_ALERT_WEBHOOK`         | —                           | Webhook URL for circuit-break/key-exhausted events                       |
| `FFAI_ALERT_TIMEOUT`         | `5000`                      | Webhook request timeout (ms)                                             |
| `FFAI_VALIDATE_KEYS`         | `false`                     | Validate keys against upstream `/models` on startup                      |
| `FFAI_VALIDATE_TIMEOUT`      | `10000`                     | Per-key validation timeout (ms)                                          |
| `FFAI_STRUCTURED_LOGS`       | `false`                     | Emit JSON logs instead of human-readable lines                           |

Provider keys go in `.env` and are referenced by `keys_var`:

```bash
GEMINI_KEYS=key1,key2,key3
GROQ_KEYS=gsk_abc,gsk_def
CEREBRAS_KEYS=csk-...
OLLAMA_KEYS=...
SAMBANOVA_KEYS=...
```

Both `.env` (env vars) and the imported keys in `config.json` (under
`providers.<name>.keys[]`) are loaded and **union-merged** at runtime.
Env keys load first; config-side keys append; duplicates are removed.

This matters for two reasons:

1. **Imports never promote env keys to disk.** When you `/ffai_import_keys`
   for a provider that uses `keys_var`, the new keys land in `config.json`
   alongside (not on top of) the env baseline. Your env-sourced secrets
   stay in env.
2. **Either source can be edited freely.** Rotate a Gemini key by editing
   `.env`, or add a new one via `/ffai_import_keys` — both take effect on
   the next pool reload (`SIGHUP` or restart). The pre-0.4.0 behaviour
   silently disabled env updates after the first import; that's fixed.

## Endpoints

| Method | Path                              | Auth                | Description                                                                       |
|--------|-----------------------------------|---------------------|-----------------------------------------------------------------------------------|
| `GET`  | `/health`                         | open / `FFAI_KEY`   | Health check (degraded → 503). Detailed per-provider stats require auth.          |
| `GET`  | `/models`                         | `FFAI_KEY`          | Unified model catalog from all providers, enriched with native specs.             |
| `POST` | `/v1/chat/completions`            | `FFAI_KEY`          | Auto-routes to the provider that owns the requested model.                        |
| `*`    | `/{provider}/v1/*`                | `FFAI_KEY`          | Proxy to a specific provider with key rotation and retries.                       |
| `GET`  | `/providers`                      | `FFAI_ADMIN_KEY`    | Provider status, key health, and circuit-breaker state.                           |
| `GET`  | `/stats`                          | `FFAI_ADMIN_KEY`    | Full per-key, per-day usage stats.                                                |
| `GET`  | `/savings`                        | `FFAI_ADMIN_KEY`    | Cost-avoided breakdown (today / month / lifetime).                                |
| `GET`  | `/smush`                          | `FFAI_ADMIN_KEY`    | Compression cache stats.                                                          |
| `GET`  | `/families`                       | `FFAI_KEY`          | Model-family routing map (provider groups serving the same family).               |
| `GET`  | `/capabilities`                   | `FFAI_KEY`          | Per-model learned capabilities (RPM/TPM observed in the wild).                    |
| `GET`  | `/generate-import`                | `FFAI_ADMIN_KEY`    | Generates the encrypt HTML page for `/ffai_encrypt`. See plugin docs.             |
| `POST` | `/import`                         | none (token in blob) | Receives an encrypted `FFAI-IMPORT:` blob, decrypts, and writes keys to the pool.|

`FFAI_ADMIN_KEY` falls back to `FFAI_KEY` if not set.

### Response headers

Every proxied response includes:
- `x-ffai-provider` — which provider handled the request
- `x-ffai-request-id` — 8-char correlation ID for log tracing
- `x-ffai-latency-ms` — total proxy latency
- `x-ffai-utilization` — current provider utilisation (`0.0` – `1.0`)
- `x-ffai-capacity-warning: low` — when the provider is running hot
- `x-ffai-modified: true` — when body sanitization rewrote the request
- `x-ffai-deprecated: true` — when the upstream model is flagged as deprecated

## Smart scoring

When `rpm_limit`, `tpm_limit`, or `rpd_limit` are set, FFAI uses
intelligent key selection instead of round-robin:

1. Each key gets a score based on current usage ratios (`0.0` = idle, `1.0` = at limit)
2. Keys closer to their limits score lower
3. Recently-used keys get a small recency penalty to spread load
4. The highest-scoring (least-loaded) key is selected
5. If a 429 reveals the actual RPM limit, it's learned and used for future scoring

**Per-key circuit breaker.** After `key_cb_threshold` consecutive errors
(default 3), the individual key is isolated for `key_cb_cooldown` ms
(default 120000). Other keys continue serving. The key auto-recovers
after the cooldown.

## Auth schemes

| Scheme   | How it works                              | Use with                                       |
|----------|-------------------------------------------|------------------------------------------------|
| `bearer` | `Authorization: Bearer <key>`             | OpenAI, Gemini OpenAI-compat, Groq, Cerebras, SambaNova |
| `header` | `<auth_header>: <key>`                    | Anthropic (`x-api-key`), Google native (`x-goog-api-key`) |
| `query`  | `?<auth_query>=<key>`                     | Google native APIs, legacy REST                |

## Streaming

SSE (Server-Sent Events) streams get extended timeouts:
- Regular requests: `request_timeout` (default 120s)
- SSE streams: `max(request_timeout * 3, 360s)` (minimum 6 minutes)
- Active SSE connections tracked for graceful shutdown (sends `data: [DONE]\n\n`)
- Cross-chunk buffering with `\n\n` delimiter parsing for JSON extraction
- Pipe timeout flag guards against writes after connection close

## OpenClaw integration

FFAI ships with a first-party OpenClaw plugin in `openclaw-plugin/`.
Install it by copying or symlinking that directory into
`~/.openclaw/extensions/ffai` and running `openclaw configure`. Full
install instructions, security model (public-key import), config schema,
and the `/ffai_stats`, `/ffai_encrypt`, `/ffai_import_keys` command
reference live in [`openclaw-plugin/README.md`](openclaw-plugin/README.md).

## Alert webhook

FFAI POSTs to `FFAI_ALERT_WEBHOOK` on critical events (throttled to 1
per event type per 60 seconds):

```json
{
  "event": "all_keys_exhausted",
  "timestamp": "2026-04-04T12:00:00.000Z",
  "message": "[gemini] All 10 keys are rate limited."
}
```

Events: `all_keys_exhausted`, `circuit_open`.

## Security details

### Header allowlists

**Outbound request headers (to upstream):**
`content-type`, `content-length`, `user-agent`, `accept`, `x-request-id`, `x-stainless-*`

**Response headers (back to client):**
`content-type`, `content-length`, `transfer-encoding`, `cache-control`,
`vary`, `retry-after`, `retry-after-ms`, `x-request-id`, `x-ratelimit-*`,
`anthropic-ratelimit-*`, `openai-processing-ms`, `openai-model`

All other headers are stripped to prevent information leakage.

### Path traversal protection

Three-layer defense:
1. Raw path check for `..` and null bytes
2. Decoded path check (`decodeURIComponent`) for double-encoded attacks (`%252e%252e`)
3. Post-construction check on resolved `url.pathname`

### Auth brute-force protection

- 10 failed auth attempts per IP within 1 minute = 5-minute block
- Stale-first eviction when tracking map exceeds 100K entries
- Periodic cleanup of expired entries every 5 minutes

### Encrypted key import

Adding API keys without SSH'ing to the server. The flow uses ECDH P-256 +
HKDF-SHA256 + AES-256-GCM so the HTML page contains only a public key —
an attacker who captures the page AND the encrypted blob still cannot
decrypt without compromising the FFAI host. Full threat model and rate
limits in [`openclaw-plugin/README.md`](openclaw-plugin/README.md#security-model).

## File structure

```
ffai/
  serve.js              # Main proxy server
  cli.js                # FFAI CLI
  index.js              # Library entry
  openclaw-plugin/      # First-party OpenClaw provider plugin
  lib/                  # Core modules (pool, discovery, smush, auth, …)
  test/                 # node:test integration tests
  config.json           # Provider configuration (not in git, mode 0600)
  config.json.example   # Provider config template
  .env                  # Environment variables (not in git, mode 0600)
  .env.example          # Environment template
  Dockerfile            # Alpine Node.js 22 container
  docker-compose.yml    # Docker Compose with loopback binding
  package.json          # Project metadata
  data/
    stats.json          # Persisted stats (auto-created)
  import-audit.log      # Per-import audit trail, in same dir as config.json
```

## License

MIT
