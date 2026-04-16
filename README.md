# KeyMux

Multi-provider API key multiplexer with smart scoring, circuit breakers, streaming, and automatic model discovery. Zero dependencies — pure Node.js.

Provider-agnostic — works with any HTTP API: OpenAI, Gemini, Anthropic, Groq, Ollama, or anything that accepts key-based auth. Each provider runs independently with its own key pool, mode, scoring, circuit breaker, and stats.

## Features

### Core
- **Multi-provider** — define multiple upstreams in `providers.json`, each with independent keys, mode, and settings
- **Path-based routing** — `/:provider/...` dispatches to the correct upstream
- **Two modes per provider** — `proxy` (full gateway) or `rotation` (key dispenser)
- **Key rotation** — round-robin or smart scoring across multiple API keys
- **Provider-agnostic auth** — configurable per provider: Bearer, custom header, query param, or none
- **Inbound auth** — protect endpoints with `PROXY_KEY` / `ADMIN_KEY` (timing-safe comparison)
- **Streaming** — pipes upstream responses directly (SSE, chunked) with extended timeouts
- **Graceful shutdown** — sends `[DONE]` to active SSE connections, flushes stats on SIGTERM/SIGINT
- **No secrets in config** — keys referenced indirectly via `keys_var` env vars

### Smart Scoring
- **Intelligent key selection** — scores keys by RPM/TPM/RPD usage ratios, cooldown proximity, error history, and recency
- **Adaptive RPM learning** — discovers actual rate limits from 429 responses and adjusts scoring
- **Per-key circuit breakers** — individual keys tripped after consecutive errors (default: 3 errors = 2min cooldown)
- **Daily usage tracking** — per-key request counts for RPD-aware distribution

### Security
- **Header allowlist** — strict allowlists for both outbound request and inbound response headers (no leaking internal headers)
- **Path traversal protection** — blocks raw, double-encoded (`%252e%252e`), and post-decoded traversal attempts
- **SSRF protection** — hostname validation on all constructed upstream URLs
- **Auth brute-force protection** — per-IP rate limiting (10 failures/min = 5min block) with stale-first eviction
- **Body size limits** — configurable per-provider max request body, enforced pre-read and during streaming
- **Request body sanitization** — strips non-standard OpenAI params, enforces output token caps
- **Log scrubbing** — API keys never appear in logs (shown as `...xxxx` suffixes)
- **Timing-safe auth** — constant-time comparison for PROXY_KEY and ADMIN_KEY

### Reliability
- **Provider-level circuit breaker** — auto-disable on repeated errors (configurable threshold/window/cooldown)
- **Per-key circuit breaker** — individual keys isolated on consecutive failures
- **Exponential retry backoff** — 100ms, 200ms, 400ms... capped at 2s, with body reset between retries
- **Rate-limit handling** — respects `Retry-After` (seconds and HTTP-date formats), auto-cooldown with configurable cap
- **Alert webhook** — throttled notifications (1/min per event type) on key exhaustion and circuit breaks
- **Async stats persistence** — non-blocking writes to disk with atomic rename

### OpenClaw Integration
- **First-party OpenClaw plugin** — `openclaw-plugin/` registers FFAI as a
  provider through OpenClaw's `providerDiscoveryEntry` API with dynamic
  catalog discovery, favorites grouping, and three slash commands
  (`/ffai_stats`, `/ffai_encrypt`, `/ffai_import_keys`). See the plugin's
  own README for install and configuration.

## Quick Start

```bash
# 1. Create your providers config
cp providers.json.example providers.json
# Edit providers.json — define your providers

# 2. Create your environment
cp .env.example .env
chmod 600 .env  # Recommended — .env holds API keys
# Edit .env — set your API keys and optional settings

# 3. Run
node serve.js
```

## Docker

```bash
cp providers.json.example providers.json
cp .env.example .env
chmod 600 .env
# Edit both files

docker compose up -d
```

The Docker setup binds to `127.0.0.1:${PORT}` on the host (loopback only). The container binds internally to `0.0.0.0`.

## Architecture

```
Client -> GET /gemini/v1/models          -> KeyMux -> generativelanguage.googleapis.com
Client -> POST /groq/v1/chat/completions -> KeyMux -> api.groq.com (key rotation + retry)
Client -> GET /spare-keys/key            -> KeyMux returns next available key (rotation mode)
```

Each provider defined in `providers.json` gets its own:
- Key pool with independent rotation or smart scoring
- Mode (proxy or rotation)
- Auth scheme (bearer, header, query, none)
- Circuit breaker (provider-level and per-key)
- Retry settings with exponential backoff
- Stats tracking (per-key, per-day)

### Request Flow (Proxy Mode)

1. Client sends request to `/:provider/path`
2. Auth check (PROXY_KEY, brute-force protection)
3. Path validation (traversal, allowed paths)
4. Body collection with size limits
5. Body sanitization (strip non-standard params, cap tokens, inject thought signatures)
6. Smart key selection (or round-robin fallback)
7. Forward to upstream with allowlisted headers
8. On retryable error: backoff, reset body, try next key
9. Stream response back with allowlisted headers + correlation ID

## Configuration

### providers.json

Define one or more providers. Each provider has its own settings:

```json
{
  "gemini": {
    "mode": "proxy",
    "upstream_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "keys_var": "GEMINI_API_KEYS",
    "auth_scheme": "bearer",
    "rpm_limit": 15,
    "tpm_limit": 1000000,
    "rpd_limit": 1500
  },
  "groq": {
    "mode": "proxy",
    "upstream_url": "https://api.groq.com/openai",
    "keys_var": "GROQ_API_KEYS",
    "auth_scheme": "bearer",
    "rpm_limit": 30,
    "tpm_limit": 6000,
    "rpd_limit": 14400
  },
  "anthropic": {
    "mode": "proxy",
    "upstream_url": "https://api.anthropic.com",
    "keys_var": "ANTHROPIC_KEYS",
    "auth_scheme": "header",
    "auth_header": "x-api-key"
  },
  "spare-keys": {
    "mode": "rotation",
    "keys_var": "SPARE_API_KEYS"
  }
}
```

#### Per-provider Settings

| Field | Default | Description |
|---|---|---|
| `mode` | `proxy` | `proxy` (full gateway) or `rotation` (key dispenser) |
| `upstream_url` | *(required for proxy)* | Upstream API base URL |
| `keys_var` | `API_KEYS` | Env var name holding comma-separated keys |
| `auth_scheme` | `bearer` | `bearer`, `header`, `query`, or `none` |
| `auth_header` | `authorization` | Header name when `auth_scheme: "header"` |
| `auth_query` | `key` | Query param name when `auth_scheme: "query"` |
| `allowed_paths` | `[]` (all) | Array of allowed path prefixes |
| `max_retries` | `3` | Max retry attempts (capped at key count) |
| `default_cooldown` | `60` | Cooldown seconds when no Retry-After header |
| `max_cooldown` | `300` | Maximum cooldown seconds |
| `retryable_statuses` | `[429,502,503]` | HTTP status codes that trigger retry |
| `request_timeout` | `120000` | Upstream request timeout (ms) |
| `max_body_size` | `2097152` | Max request body (2MB default, bytes) |
| `max_output_tokens` | `0` | Max output tokens cap (0 = no cap) |
| `cb_threshold` | `0` (off) | Errors within window to trip provider circuit breaker |
| `cb_window` | `60000` | Provider CB error counting window (ms) |
| `cb_cooldown` | `120000` | Provider CB open duration (ms) |
| `rpm_limit` | `0` | Requests per minute per key (0 = unknown, enables smart scoring) |
| `tpm_limit` | `0` | Tokens per minute per key |
| `rpd_limit` | `0` | Requests per day per key |
| `key_cb_threshold` | `3` | Consecutive errors to trip per-key CB |
| `key_cb_cooldown` | `120000` | Per-key CB cooldown (ms) |
| `models_cache_ttl` | `300000` | /models response cache TTL (ms) |

### Environment Variables (.env)

Global settings. Because `.env` holds API keys, `chmod 600 .env` is strongly recommended.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8002` | Listen port |
| `BIND_ADDRESS` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `PROVIDERS_FILE` | `./providers.json` | Path to providers config |
| `PROXY_KEY` | *(empty)* | Shared secret for proxy/rotation endpoints |
| `ADMIN_KEY` | *(empty)* | Shared secret for `/stats` endpoint |
| `ALERT_WEBHOOK_URL` | *(empty)* | Webhook URL for alerts |
| `ALERT_TIMEOUT` | `5000` | Webhook request timeout (ms) |
| `STATS_FILE` | `./data/stats.json` | Stats persistence path |
| `STATS_FLUSH_INTERVAL` | `60000` | Stats write interval (ms) |
| `STATS_RETENTION_DAYS` | `7` | Days of stats history |
| `SHUTDOWN_TIMEOUT` | `5000` | Force-exit timeout (ms) |

API keys are set in `.env`, referenced by `keys_var` in each provider:
```bash
GEMINI_API_KEYS=key1,key2,key3
GROQ_API_KEYS=gsk_abc,gsk_def
ANTHROPIC_KEYS=sk-ant-xxx,sk-ant-yyy
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | open | Health check (503 when any provider degraded). Detailed per-key stats require `ADMIN_KEY` |
| `GET` | `/models` | `PROXY_KEY` | Aggregated model list from all proxy-mode providers (10s per-provider timeout) |
| `GET` | `/stats` | `ADMIN_KEY`* | Full stats with daily history per provider/key |
| `GET` | `/providers` | `PROXY_KEY` | List all providers (names, modes, key counts) |
| `GET` | `/:provider/key` | `PROXY_KEY` | Get next available key (rotation mode only) |
| `POST` | `/:provider/key/:id/cooldown` | `PROXY_KEY` | Report key rate-limited (rotation mode, requires unique suffix match) |
| `*` | `/:provider/*` | `PROXY_KEY` | Proxied to upstream (proxy mode) |

*`ADMIN_KEY` falls back to `PROXY_KEY` if not set. Rotation mode requires `PROXY_KEY` (enforced at startup).

### Response Headers

All proxied responses include:
- `x-request-id` — 8-character correlation ID for log tracing
- `x-keymux-modified` — present when request body was sanitized (params stripped, tokens capped, thought signatures injected)

## Smart Scoring

When `rpm_limit`, `tpm_limit`, or `rpd_limit` are set for a provider, KeyMux uses intelligent key selection instead of round-robin:

```json
{
  "gemini": {
    "rpm_limit": 15,
    "tpm_limit": 1000000,
    "rpd_limit": 1500
  }
}
```

**How it works:**
1. Each key gets a score based on current usage ratios (0.0 = idle, 1.0 = at limit)
2. Keys closer to their limits score lower
3. Recently-used keys get a small recency penalty to spread load
4. The highest-scoring (least-loaded) key is selected
5. If a 429 reveals the actual RPM limit, it's learned and used for future scoring

**Per-key circuit breaker:** After 3 consecutive errors (configurable via `key_cb_threshold`), the individual key is isolated for 2 minutes. Other keys continue serving. The key auto-recovers after the cooldown.

## Circuit Breaker

### Provider-Level

Protects against cascading failures. Set in `providers.json`:

```json
{
  "gemini": {
    "cb_threshold": 10,
    "cb_window": 60000,
    "cb_cooldown": 120000
  }
}
```

- 10 errors within 1 minute (with no intervening 2xx/3xx success) trips the circuit
- Provider is blocked for 2 minutes, returns 503 to clients
- `/health` shows `"circuitBreaker": "open"`
- Alert webhook fires with event `circuit_open` (throttled to 1/min)
- Episode tracking prevents alert spam during key flapping

### Per-Key

Automatic, always active:
- 3 consecutive errors per key = 2min isolation (configurable)
- Other keys in the same provider continue working
- Key auto-recovers after cooldown

## Auth Schemes

| Scheme | How it works | Use with |
|---|---|---|
| `bearer` | `Authorization: Bearer <key>` | OpenAI, Gemini OpenAI-compat, Groq |
| `header` | `<auth_header>: <key>` | Anthropic (`x-api-key`), Google (`x-goog-api-key`) |
| `query` | `?<auth_query>=<key>` | Google native APIs, legacy REST |
| `none` | No auth injection | Ollama, pre-authed upstreams |

## Modes

### Proxy Mode (default)

Full transparent proxy. Clients send requests to KeyMux as if it were the upstream API:

```bash
curl http://localhost:8002/gemini/v1/chat/completions \
  -H "Authorization: Bearer $PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"hi"}]}'
```

KeyMux injects the API key, sanitizes the request body, forwards to upstream with retries, and streams the response back.

**Body sanitization** (for `/chat/completions` requests):
- Strips non-standard keys (e.g., `store`, `reasoning_effort`, `thinking`)
- Normalizes `max_completion_tokens` to `max_tokens`
- Caps `max_tokens` if provider has `max_output_tokens` set
- Injects cached Gemini 3 thought signatures for tool calling
- Compacts unsigned tool calls to text (prevents Gemini rejection)

### Rotation Mode

Key-dispenser mode. No proxying — clients fetch a key and connect directly:

```bash
# Get next available key (includes audit trail with correlation ID)
curl http://localhost:8002/spare-keys/key \
  -H "Authorization: Bearer $PROXY_KEY"
# {"key":"sk-abc...xyz","upstream_url":null,"provider":"spare-keys"}

# Report a rate limit (suffix must uniquely identify one key)
curl -X POST http://localhost:8002/spare-keys/key/xyz1/cooldown \
  -H "Authorization: Bearer $PROXY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"retry_after": 60}'
```

## Alert Webhook

KeyMux POSTs to `ALERT_WEBHOOK_URL` on critical events (throttled to 1 per event type per 60 seconds):

```json
{
  "event": "all_keys_exhausted",
  "timestamp": "2026-04-04T12:00:00.000Z",
  "message": "[gemini] All 10 keys are rate limited."
}
```

Events: `all_keys_exhausted`, `circuit_open`

## OpenClaw Integration

FFAI ships with a first-party OpenClaw plugin in `openclaw-plugin/`. Install
it by copying or symlinking that directory into `~/.openclaw/extensions/ffai`
and running `openclaw configure`. Full install instructions, config schema,
and the `/ffai_stats`, `/ffai_encrypt`, `/ffai_import_keys` command reference
live in [`openclaw-plugin/README.md`](openclaw-plugin/README.md).

## Streaming

SSE (Server-Sent Events) streams get extended timeouts:
- Regular requests: `request_timeout` (default 120s)
- SSE streams: `max(request_timeout * 3, 360s)` (minimum 6 minutes)
- Active SSE connections tracked for graceful shutdown (sends `data: [DONE]\n\n`)
- Cross-chunk buffering with `\n\n` delimiter parsing for JSON extraction
- Pipe timeout flag guards against writes after connection close

## Security Details

### Header Allowlists

**Outbound request headers** (to upstream):
`content-type`, `content-length`, `user-agent`, `accept`, `x-request-id`, `x-stainless-*`

**Response headers** (back to client):
`content-type`, `content-length`, `content-encoding`, `cache-control`, `date`, `vary`, `x-request-id`, `x-ratelimit-*`, `retry-after`, `openai-*`

All other headers are stripped to prevent information leakage.

### Path Traversal Protection

Three-layer defense:
1. Raw path check for `..` and null bytes
2. Decoded path check (`decodeURIComponent`) for double-encoded attacks (`%252e%252e`)
3. Post-construction check on resolved `url.pathname`

### Auth Brute-Force Protection

- 10 failed auth attempts per IP within 1 minute = 5-minute block
- Stale-first eviction when tracking map exceeds 100K entries
- Periodic cleanup of expired entries every 5 minutes

## File Structure

```
ffai/
  serve.js              # Main proxy server
  cli.js                # FFAI CLI
  index.js              # Library entry
  openclaw-plugin/      # First-party OpenClaw provider plugin
  lib/                  # Core modules (pool, discovery, smush, auth, …)
  providers.json        # Provider configuration (not in git)
  .env                  # Environment variables (not in git, mode 600)
  .env.example          # Environment template
  providers.json.example # Provider config template
  Dockerfile            # Alpine Node.js 22 container
  docker-compose.yml    # Docker Compose with loopback binding
  package.json          # Project metadata
  data/
    stats.json          # Persisted stats (auto-created)
```

## License

MIT
