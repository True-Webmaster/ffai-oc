# KeyMux

API key multiplexer with rotation, rate-limit handling, per-key stats, and webhook alerting. Zero dependencies — pure Node.js.

Provider-agnostic — works with any HTTP API: OpenAI, Gemini, Anthropic, Ollama, REST APIs, or anything that accepts key-based auth.

## Features

- **Key rotation** — round-robin across multiple API keys with automatic cooldown on 429
- **Two modes** — `proxy` (full gateway) or `rotation` (key dispenser for direct-connect clients)
- **Provider-agnostic** — configurable auth scheme (Bearer, custom header, query param, or none)
- **Flexible paths** — no hardcoded `/v1/` restriction; allow all paths or configure prefixes
- **Rate-limit handling** — respects `Retry-After`, auto-cooldown, retry with next key
- **SSRF protection** — hostname validation on constructed URLs
- **Stats** — per-key request/error/rate-limit tracking, configurable history, persisted to disk
- **Alerts** — webhook notifications when all keys are exhausted
- **Streaming** — pipes upstream responses directly (SSE, chunked)
- **Graceful shutdown** — flushes stats on SIGTERM/SIGINT
- **No secrets in config** — keys referenced indirectly via `KEYS_VAR`

## Quick Start

```bash
cp .env.example .env
# Edit .env — set KEYS_VAR (pointing to your keys env var) and UPSTREAM_URL

node server.js
```

## Docker

```bash
cp .env.example .env
# Edit .env

docker compose up -d
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KEYS_VAR` | `API_KEYS` | Name of the env var holding comma-separated keys |
| `UPSTREAM_URL` | *(required in proxy mode)* | Upstream API base URL |
| `PORT` | `8002` | Listen port |
| `MODE` | `proxy` | `proxy` or `rotation` |
| `AUTH_SCHEME` | `bearer` | `bearer`, `header`, `query`, or `none` |
| `AUTH_HEADER` | `authorization` | Header name when `AUTH_SCHEME=header` |
| `AUTH_QUERY` | `key` | Query param name when `AUTH_SCHEME=query` |
| `ALLOWED_PATHS` | *(empty = all)* | Comma-separated path prefixes (e.g. `/v1/,/api/`) |
| `MAX_RETRIES` | `3` | Max retry attempts per request (capped at key count) |
| `DEFAULT_COOLDOWN` | `60` | Cooldown seconds when no Retry-After header |
| `MAX_BODY_SIZE` | `2097152` | Max request body (bytes) |
| `REQUEST_TIMEOUT` | `120000` | Upstream timeout (ms) |
| `ALERT_WEBHOOK_URL` | *(empty)* | Webhook for all-keys-exhausted alerts |
| `ALERT_TIMEOUT` | `5000` | Webhook request timeout (ms) |
| `STATS_FILE` | `./data/stats.json` | Stats persistence path |
| `STATS_FLUSH_INTERVAL` | `60000` | Stats write interval (ms) |
| `STATS_RETENTION_DAYS` | `7` | Days of stats history |
| `SHUTDOWN_TIMEOUT` | `5000` | Force-exit timeout after graceful shutdown (ms) |

## Auth Schemes

KeyMux supports four ways to inject keys into upstream requests:

| Scheme | How it works | Use with |
|---|---|---|
| `bearer` | `Authorization: Bearer <key>` | OpenAI, Gemini OpenAI-compat, most LLMs |
| `header` | `<AUTH_HEADER>: <key>` | Anthropic (`x-api-key`), Google (`x-goog-api-key`) |
| `query` | `?<AUTH_QUERY>=<key>` | Google APIs, legacy REST services |
| `none` | No auth injection | Rate-limit-only proxying, pre-authed upstreams |

### Examples

**OpenAI / Gemini (Bearer):**
```bash
UPSTREAM_URL=https://api.openai.com/v1
AUTH_SCHEME=bearer
```

**Anthropic (custom header):**
```bash
UPSTREAM_URL=https://api.anthropic.com
AUTH_SCHEME=header
AUTH_HEADER=x-api-key
```

**Google AI (query param):**
```bash
UPSTREAM_URL=https://generativelanguage.googleapis.com/v1beta
AUTH_SCHEME=query
AUTH_QUERY=key
```

## Modes

### Proxy mode (default)

Full transparent proxy. Clients send requests to KeyMux as if it were the upstream API:

```bash
curl http://localhost:8002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

KeyMux injects the API key, forwards to upstream, handles 429 retries, and streams the response back.

### Rotation mode

Key-dispenser mode. No proxying — clients fetch a key and connect to the upstream directly:

```bash
# Get next available key
curl http://localhost:8002/key
# → {"key":"sk-abc...xyz","upstream_url":"https://api.openai.com/v1"}

# Report a rate limit (so KeyMux cools down that key)
curl -X POST http://localhost:8002/key/xyz/cooldown \
  -H "Content-Type: application/json" \
  -d '{"retry_after": 60}'
```

## Endpoints

| Method | Path | Modes | Description |
|---|---|---|---|
| `GET` | `/health` | both | Health check with today's stats |
| `GET` | `/stats` | both | Full stats with daily history |
| `GET` | `/key` | rotation | Get next available key |
| `POST` | `/key/:id/cooldown` | rotation | Report key rate-limited |
| `*` | `/*` | proxy | Proxied to upstream (filtered by `ALLOWED_PATHS` if set) |

## Alert Webhook

When all keys are exhausted, KeyMux POSTs to `ALERT_WEBHOOK_URL`:

```json
{
  "event": "all_keys_exhausted",
  "timestamp": "2026-04-04T12:00:00.000Z",
  "message": "All 3 keys are rate limited. Shortest cooldown: 42s.",
  "stats": { "requests_today": 1234, "rate_limited_today": 5 }
}
```
