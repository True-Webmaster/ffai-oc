# KeyMux

Multi-provider API key multiplexer with rotation, rate-limit handling, per-key stats, and webhook alerting. Zero dependencies — pure Node.js.

Provider-agnostic — works with any HTTP API: OpenAI, Gemini, Anthropic, Groq, Ollama, REST APIs, or anything that accepts key-based auth. Each provider runs independently with its own key pool, mode, circuit breaker, and stats.

## Features

- **Multi-provider** — define multiple upstreams in `providers.json`, each with independent keys, mode, and settings
- **Path-based routing** — `/:provider/...` dispatches to the correct upstream
- **Two modes per provider** — `proxy` (full gateway) or `rotation` (key dispenser)
- **Key rotation** — round-robin across multiple API keys with automatic cooldown on 429
- **Provider-agnostic auth** — configurable per provider: Bearer, custom header, query param, or none
- **Inbound auth** — protect endpoints with `PROXY_KEY` / `ADMIN_KEY`
- **Circuit breaker** — per-provider auto-disable on repeated errors (kill switch for runaway agents)
- **Retryable statuses** — configurable retry on 429, 502, 503, etc.
- **Rate-limit handling** — respects `Retry-After`, auto-cooldown with configurable cap
- **SSRF protection** — hostname validation on constructed URLs
- **Stats** — per-provider, per-key request/error/rate-limit tracking, persisted to disk (atomic writes)
- **Alerts** — webhook notifications on all-keys-exhausted and circuit-breaker events
- **Streaming** — pipes upstream responses directly (SSE, chunked)
- **Graceful shutdown** — flushes stats on SIGTERM/SIGINT
- **No secrets in config** — keys referenced indirectly via `keys_var`

## Quick Start

```bash
# 1. Create your providers config
cp providers.json.example providers.json
# Edit providers.json — define your providers

# 2. Create your environment
cp .env.example .env
# Edit .env — set your API keys and optional settings

# 3. Run
node server.js
```

## Docker

```bash
cp providers.json.example providers.json
cp .env.example .env
# Edit both files

docker compose up -d
```

## Architecture

```
Client → GET /gemini/v1/models         → KeyMux → https://generativelanguage.googleapis.com/v1beta/openai/v1/models
Client → POST /groq/v1/chat/completions → KeyMux → https://api.groq.com/openai/v1/chat/completions
Client → GET /spare-keys/key           → KeyMux returns next available key (rotation mode)
```

Each provider defined in `providers.json` gets its own:
- Key pool with independent rotation
- Mode (proxy or rotation)
- Auth scheme
- Circuit breaker
- Retry settings
- Stats tracking

## Configuration

### providers.json

Define one or more providers. Each provider has its own settings:

```json
{
  "gemini": {
    "mode": "proxy",
    "upstream_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    "keys_var": "GEMINI_API_KEYS",
    "auth_scheme": "bearer"
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

#### Per-provider settings

| Field | Default | Description |
|---|---|---|
| `mode` | `proxy` | `proxy` or `rotation` |
| `upstream_url` | *(required in proxy mode)* | Upstream API base URL |
| `keys_var` | `API_KEYS` | Env var name holding comma-separated keys |
| `auth_scheme` | `bearer` | `bearer`, `header`, `query`, or `none` |
| `auth_header` | `authorization` | Header name when `auth_scheme: "header"` |
| `auth_query` | `key` | Query param name when `auth_scheme: "query"` |
| `allowed_paths` | `[]` (all) | Array of allowed path prefixes |
| `max_retries` | `3` | Max retry attempts (capped at key count) |
| `default_cooldown` | `60` | Cooldown seconds when no Retry-After header |
| `max_cooldown` | `300` | Maximum cooldown seconds |
| `retryable_statuses` | `[429,502,503]` | HTTP status codes that trigger retry |
| `request_timeout` | `120000` | Upstream timeout (ms) |
| `max_body_size` | `2097152` | Max request body (bytes) |
| `cb_threshold` | `0` (disabled) | Errors within window to trip circuit breaker |
| `cb_window` | `60000` | Error counting window (ms) |
| `cb_cooldown` | `120000` | Circuit open duration (ms) |

### Environment Variables (.env)

Global settings that apply across all providers:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8002` | Listen port |
| `BIND_ADDRESS` | `0.0.0.0` | Bind address |
| `PROVIDERS_FILE` | `./providers.json` | Path to providers config |
| `PROXY_KEY` | *(empty)* | Shared secret for proxy/rotation endpoints |
| `ADMIN_KEY` | *(empty)* | Shared secret for `/stats` endpoint |
| `ALERT_WEBHOOK_URL` | *(empty)* | Webhook for alerts |
| `ALERT_TIMEOUT` | `5000` | Webhook request timeout (ms) |
| `STATS_FILE` | `./data/stats.json` | Stats persistence path |
| `STATS_FLUSH_INTERVAL` | `60000` | Stats write interval (ms) |
| `STATS_RETENTION_DAYS` | `7` | Days of stats history |
| `SHUTDOWN_TIMEOUT` | `5000` | Force-exit timeout (ms) |

API keys are also set in `.env` (or your environment), referenced by `keys_var` in each provider:
```bash
GEMINI_API_KEYS=key1,key2,key3
GROQ_API_KEYS=gsk_abc,gsk_def
ANTHROPIC_KEYS=sk-ant-xxx,sk-ant-yyy
```

## Inbound Auth

Protect KeyMux from unauthorized access:

```bash
export PROXY_KEY="my-secret-proxy-key"
export ADMIN_KEY="my-secret-admin-key"
```

Clients include the key in requests:
```bash
curl http://localhost:8002/gemini/v1/chat/completions \
  -H "Authorization: Bearer my-secret-proxy-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"hi"}]}'
```

- `/health` — always open (no auth), needed for orchestrators. Detailed per-key stats require `ADMIN_KEY`
- `/stats` — requires `ADMIN_KEY` (falls back to `PROXY_KEY` if `ADMIN_KEY` not set)
- `/providers` — requires `PROXY_KEY`
- `/:provider/*` — requires `PROXY_KEY` if set

## Circuit Breaker (Kill Switch)

Per-provider protection against runaway agents. Set in `providers.json`:

```json
{
  "gemini": {
    "cb_threshold": 10,
    "cb_window": 60000,
    "cb_cooldown": 120000
  }
}
```

- 10 errors within 1 minute (with no intervening 2xx/3xx success) blocks that provider for 2 minutes
- Any successful response (2xx/3xx) resets the error counter
- `/health` shows `"circuitBreaker": "open"` for affected providers
- Alert webhook fires with event `circuit_open`
- Other providers continue working normally

## Auth Schemes

Configured per provider in `providers.json`:

| Scheme | How it works | Use with |
|---|---|---|
| `bearer` | `Authorization: Bearer <key>` | OpenAI, Gemini OpenAI-compat, most APIs |
| `header` | `<auth_header>: <key>` | Anthropic (`x-api-key`), Google (`x-goog-api-key`) |
| `query` | `?<auth_query>=<key>` | Google APIs, legacy REST services |
| `none` | No auth injection | Rate-limit-only proxying, pre-authed upstreams |

### Examples

**OpenAI (Bearer):**
```json
{ "upstream_url": "https://api.openai.com/v1", "auth_scheme": "bearer" }
```

**Anthropic (custom header):**
```json
{ "upstream_url": "https://api.anthropic.com", "auth_scheme": "header", "auth_header": "x-api-key" }
```

**Google AI (query param):**
```json
{ "upstream_url": "https://generativelanguage.googleapis.com/v1beta", "auth_scheme": "query", "auth_query": "key" }
```

## Modes

### Proxy mode (default)

Full transparent proxy. Clients send requests to KeyMux as if it were the upstream API:

```bash
curl http://localhost:8002/gemini/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-2.0-flash","messages":[{"role":"user","content":"hi"}]}'
```

KeyMux injects the API key, forwards to upstream, handles retries, and streams the response back.

### Rotation mode

Key-dispenser mode. No proxying — clients fetch a key and connect directly:

```bash
# Get next available key
curl http://localhost:8002/spare-keys/key
# {"key":"sk-abc...xyz","upstream_url":null,"provider":"spare-keys"}

# Report a rate limit
curl -X POST http://localhost:8002/spare-keys/key/xyz1/cooldown \
  -H "Content-Type: application/json" \
  -d '{"retry_after": 60}'
```

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | open | Health check (returns 503 when any provider degraded) |
| `GET` | `/stats` | `ADMIN_KEY`* | Full stats with daily history per provider |
| `GET` | `/providers` | `PROXY_KEY` | List all providers (names and modes) |
| `GET` | `/:provider/key` | `PROXY_KEY` | Get next available key (rotation mode) |
| `POST` | `/:provider/key/:id/cooldown` | `PROXY_KEY` | Report key rate-limited (rotation mode) |
| `*` | `/:provider/*` | `PROXY_KEY` | Proxied to upstream (proxy mode) |

*`ADMIN_KEY` falls back to `PROXY_KEY` if not set. Rotation mode requires `PROXY_KEY` to be set (enforced at startup).

## Alert Webhook

KeyMux POSTs to `ALERT_WEBHOOK_URL` on critical events:

```json
{
  "event": "all_keys_exhausted",
  "timestamp": "2026-04-04T12:00:00.000Z",
  "message": "[gemini] All 5 keys are rate limited."
}
```

Events: `all_keys_exhausted`, `circuit_open`
