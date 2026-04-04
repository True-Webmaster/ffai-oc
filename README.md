# KeyMux

LLM API key multiplexer with rotation, rate-limit handling, per-key stats, and webhook alerting. Zero dependencies — pure Node.js.

Works with any OpenAI-compatible upstream (OpenAI, Gemini, Ollama, vLLM, etc.).

## Features

- **Key rotation** — round-robin across multiple API keys with automatic cooldown on 429
- **Two modes** — `proxy` (full gateway) or `rotation` (key dispenser for direct-connect clients)
- **OpenAI-compatible** — transparent proxy for `/v1/*` endpoints
- **Rate-limit handling** — respects `Retry-After`, auto-cooldown, retry with next key
- **SSRF protection** — hostname validation on constructed URLs
- **Stats** — per-key request/error/rate-limit tracking, 7-day history, persisted to disk
- **Alerts** — webhook notifications when all keys are exhausted
- **Streaming** — pipes upstream responses directly (SSE, chunked)
- **Graceful shutdown** — flushes stats on SIGTERM/SIGINT

## Quick Start

```bash
cp .env.example .env
# Edit .env — at minimum set LLM_KEYS and LLM_BASE_URL

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
| `KEYS_VAR` | `LLM_KEYS` | Name of the env var holding your comma-separated API keys |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Upstream base URL |
| `PORT` | `8002` | Listen port |
| `MODE` | `proxy` | `proxy` or `rotation` |
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

## Modes

### Proxy mode (default)

Full transparent proxy. Clients send requests to the gateway as if it were the upstream API:

```bash
curl http://localhost:8002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'
```

The gateway injects the API key, forwards to upstream, handles 429 retries, and streams the response back.

### Rotation mode

Key-dispenser mode. No proxying — clients fetch a key and connect to the upstream directly:

```bash
# Get next available key
curl http://localhost:8002/key
# → {"key":"sk-abc...xyz","base_url":"https://api.openai.com/v1"}

# Report a rate limit (so the gateway cools down that key)
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
| `*` | `/v1/*` | proxy | Proxied to upstream |

## TrueMem Integration

Point TrueMem at the gateway as an external LLM service:

```json
{
  "llmProxy": {
    "enabled": false
  },
  "llm": {
    "baseUrl": "http://localhost:8002/v1",
    "model": "gemini-3.1-flash-lite-preview"
  }
}
```

## Alert Webhook

When all keys are exhausted, the gateway POSTs to `ALERT_WEBHOOK_URL`:

```json
{
  "event": "all_keys_exhausted",
  "timestamp": "2026-04-04T12:00:00.000Z",
  "message": "All 3 keys are rate limited. Shortest cooldown: 42s.",
  "stats": { "requests_today": 1234, "rate_limited_today": 5 }
}
```
