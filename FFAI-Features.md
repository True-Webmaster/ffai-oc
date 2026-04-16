# FFAI — Free Freaking AI

### Use every free-tier AI API like a single, unlimited one.

FFAI is a zero-dependency Node.js proxy that pools free API keys from multiple AI providers, rotates them intelligently, and presents a single OpenAI-compatible endpoint. Drop it in front of any app that speaks `/v1/chat/completions` — it handles the rest.

**Version 0.3.0** | MIT License | Node.js >= 18 | Zero dependencies

---

## Why FFAI?

Every major AI provider offers a free tier — Gemini gives you 1,500 requests/day per key, Groq gives you 14,400, Cerebras gives you unlimited. The catch? Each key has tight rate limits.

FFAI removes that ceiling. Pool 10 Gemini keys and you have 15,000 requests/day. Add 5 Groq keys and you have 72,000. FFAI scores each key in real time, picks the least-loaded one, and handles all the 429s, cooldowns, and circuit breakers so your app never sees a rate limit.

**Real savings:** In our deployment, FFAI has saved **$5.70 in the first week** across 356 requests — and that's with light usage. Scale to thousands of requests and you're looking at hundreds of dollars per month, all on free-tier keys.

---

## How It Works

```
Your App  ──>  FFAI (:8010)  ──>  Gemini (10 keys)
                    |          ──>  Groq (5 keys)
                    |          ──>  Cerebras (3 keys)
                    |          ──>  Ollama (local)
                    |          ──>  OpenAI, Mistral, OpenRouter...
```

1. Your app sends a standard OpenAI-format request to FFAI
2. FFAI identifies the provider from the model name
3. The scoring engine picks the best key (least loaded, lowest error rate, most capacity)
4. Request proxied upstream with the selected key
5. If rate-limited, FFAI retries with a different key — your app never knows

---

## Core Features

### Intelligent Key Scoring

Not just round-robin. FFAI's scoring engine evaluates every key on 7 factors before each request:

- **Usage ratios** — RPM, TPM, RPD, TPD utilization (0.0 idle to 1.0 at limit)
- **Cooldown proximity** — keys near their limits score lower
- **Recency** — recently-used keys get a small penalty to spread load
- **Error history** — keys with recent errors are deprioritized
- **Per-key circuit breakers** — 3 consecutive errors = 2min isolation, then auto-recover
- **Latency tracking** — time-to-first-token tracked per model for tie-breaking
- **Adaptive learning** — when a 429 reveals the real rate limit, FFAI learns it and adjusts scoring

The result: your requests always go to the key with the most headroom.

### Free-Tier Awareness

FFAI ships with a built-in database of free-tier rate limits for every major provider:

| Provider | RPM/key | RPD/key | TPM/key | Daily Reset |
|----------|---------|---------|---------|-------------|
| **Gemini** | 5-15 | 100-1,500 | 250K-1M | Midnight PT |
| **Groq** | 30-60 | 1,000-14,400 | 6K-60K | Rolling |
| **Cerebras** | 30 | 14,400 | 60K | Rolling |
| **OpenAI** | 3 | 200 | 10K-60K | Rolling |
| **Mistral** | 2 | - | 500K | Rolling |

Zero config needed — FFAI auto-applies the right limits when you add keys. Per-model overrides included (e.g., Gemini 2.5 Pro has stricter limits than Flash).

### Multi-Provider Support

Currently configured with **4 providers** in our deployment:

- **Gemini** (Google) — 1,500 requests/day per key, 1M tokens/minute
- **Groq** — 14,400 requests/day per key, fastest inference around
- **Cerebras** — 14,400 requests/day per key, massive context windows
- **Ollama** — Local, self-hosted, unlimited

The architecture supports any OpenAI-compatible API — just drop it into `config.json` with one of four auth schemes (`bearer`, `header`, `query`, `none`) and FFAI handles the rest. Adding a new provider like OpenRouter or Mistral is a 5-line config change, no code needed.

### Automatic Model Discovery

On startup (and again whenever you import new keys), FFAI queries each provider to build a unified model catalog:

- Hits each provider's `/models` endpoint
- Filters out non-chat models (embeddings, image gen, TTS, audio, etc.)
- Enriches with context window sizes and max output tokens
- Deduplicates versioned models (`model-001` skipped when `model` exists)
- Filters by minimums: 32K context window, 4K output tokens, 4B parameters
- Exposes everything through a single `/models` endpoint

Your app sees one unified model list. FFAI handles the routing based on model name. No background polling — discovery only runs when something actually changed.

### Message Compression (Smush)

Optional built-in engine that reduces input tokens before they hit the upstream API:

- **Text compression** — semantic compaction of conversation history
- **Command deduplication** — repeated instructions consolidated
- **Abstractive summarization** — long conversations auto-summarized
- **LRU cache** — compressed messages cached for repeat patterns

Every token saved is a token that doesn't count against your rate limit — effectively multiplying your free-tier capacity.

### Savings Tracking

FFAI calculates what your usage would cost at market rates:

```
FFAI Usage & Savings
━━━━━━━━━━━━━━━━━━━━━━━━━
Today:
  88 requests, 2.2M tokens (in: 2.2M, out: 0)
  Cost avoided: $2.80
  Compression: ~500K tokens saved

Last 30 days:
  356 requests, 4.6M tokens
  Cost avoided: $5.70
  Compression: ~793K tokens saved

Top providers:
  gemini: 304 req, $5.65 saved
  groq: 27 req, $0.002 saved
```

Built-in pricing table: Gemini ($1.25/$5.00 per 1M in/out), Groq ($0.05/$0.10), Cerebras ($0.10/$0.10), OpenAI ($2.50/$10.00), and more. Accessible via the `/savings` API endpoint.

---

## Resilience

### Smart Retry Engine

Not all errors are the same. FFAI uses exception-aware retry policies:

| Error Type | Retries | Strategy |
|-----------|---------|----------|
| 429 Rate Limit | 3 | Aggressive — switch keys immediately |
| 500/502/503 Server | 2 | Cautious — exponential backoff |
| Network/Timeout | 2 | Cautious — try different key |
| 401/403 Auth | 0 | Never retry — key is invalid |
| Other 4xx | 0 | Never retry — client error |

Backoff formula: `min(100ms * 2^attempt, 2000ms)`. Request body preserved and reset between retries.

### Two-Level Circuit Breakers

**Per-key:** 3 consecutive errors isolates a single key for 2 minutes. Other keys keep serving.

**Per-provider:** 10 errors in 60 seconds trips the whole provider for 2 minutes. Prevents hammering a provider that's down.

Both auto-recover. Alert webhooks fire on state changes (throttled to 1 per event type per 60s).

### Provider-Specific Error Parsing

FFAI understands each provider's error format:

- **Gemini:** Parses `error.details[].metadata.quota_metric` to identify which limit was hit (per-minute vs per-day)
- **Groq:** Reads `x-ratelimit-remaining-*` headers, detects daily limits from reset time
- **Generic:** Falls back to standard `Retry-After` headers (seconds or HTTP-date)

When a daily limit is hit, the key is blocked for the rest of the day — no wasted retries.

### SSE Streaming

Full Server-Sent Events support with:

- Extended timeouts for streaming (minimum 6 minutes, configurable)
- Backpressure-aware piping
- Cross-chunk JSON parsing (handles split SSE messages)
- Usage token extraction from stream chunks
- Graceful shutdown with `data: [DONE]` to all active streams

---

## Security (v0.3.0 Hardened)

18-finding security audit, all addressed:

- **Timing-safe auth** — HMAC-SHA256 comparison eliminates timing side-channels
- **Brute-force protection** — 10 failures/min = 5-minute IP block (100K entry cap, stale-first eviction)
- **Path traversal defense** — 3-layer check (raw, decoded, resolved)
- **Header allowlists** — strict allowlists for both request and response headers (all unlisted headers stripped)
- **Localhost binding** — default bind is `127.0.0.1` (not `0.0.0.0`)
- **Atomic config writes** — write-to-tmp + rename prevents crash corruption
- **Log scrubbing** — API keys shown as `...xxxx` in all logs
- **Error sanitization** — upstream errors truncated and key patterns redacted before display
- **HTTPS enforcement** — remote sync requires HTTPS for non-loopback URLs

### Encrypted Key Import

Adding API keys to a server is usually awkward — you either SSH in and edit config files, or you paste secrets into a chat where they can be logged. FFAI's import flow is built so that **neither the chat transport nor the HTML file can leak the keys**, even if both are captured.

1. **Run `/ffai_encrypt` in OpenClaw** — FFAI generates a self-contained HTML page and sends it to you (via Telegram file attachment or a local path). The page has FFAI's ECDH P-256 **public key** baked in. No decryption secret lives in the HTML.
2. **Open the HTML page in any browser** — no network needed. The page auto-detects the provider from the key format (or you pick manually), then performs ECDH with the baked-in server pubkey, derives an AES-256 key via HKDF-SHA256, and encrypts the keys with AES-256-GCM.
3. **Copy the `FFAI-IMPORT:` blob** — this is the encrypted payload. It can only be decrypted by whoever holds the matching private key, i.e. the FFAI server.
4. **Paste it in OpenClaw chat with `/ffai_import_keys`** — the plugin forwards the blob verbatim to FFAI.
5. **FFAI decrypts, validates each key against the provider's format, and hot-reloads** — no restart needed. Mismatches are rejected before touching the pool.

The keys never exist in plaintext anywhere except inside your browser tab and inside FFAI's memory. They never touch a log file, a chat history, or a disk (before encryption).

**Why the HTML is safe to leak:** the HTML contains only a public key. Decryption requires the private half, which lives in FFAI's `config.json` (mode `0600`) and never leaves the host. An attacker with the HTML *and* the encrypted blob cannot recover the keys — they'd need to compromise the FFAI host itself, at which point the plaintext provider keys in `config.json` are already exposed anyway.

**Security guarantees:**
- **Public-key crypto** — ECDH P-256 + HKDF-SHA256 + AES-256-GCM. Web Crypto primitives, widely-reviewed, universally supported.
- **Replay-proof** — every decrypted blob carries a random 18-byte nonce; the server remembers used nonces for 24h and rejects re-submissions.
- **Freshness gate** — blobs older than 24h are rejected by timestamp.
- **Rate limited** — 10 attempts per minute per IP. Repeated failures feed the global auth brute-force guard (10 failures → 5 min IP block).
- **Format validation** — each key must match the declared provider's fingerprint (Gemini `AIza…`, Groq `gsk_…`, Cerebras `csk-…`, Ollama `{hex}.{alnum}`, SambaNova UUID). Mislabeled keys never enter the pool.
- **Audit trail** — every import attempt (success, empty, replay, stale, decrypt-failed, rate-limited) is logged to `${configDir}/import-audit.log` as JSONL with timestamp, IP, provider, and reason.

**What this does NOT protect against:** an active adversary watching your chat session in real time can see the plaintext keys in the HTML page's textarea during the ~500ms between "user pastes" and "browser encrypts". That's a fundamental limit of running the crypto in a browser you don't fully control; no redesign fixes it short of using a separate trusted device. The v2 design is specifically hardened for the "leaked transcript, hours or days later" threat — which was the common case.

---

## API

Drop-in replacement for OpenAI's API. Change your base URL and you're done.

### Proxy Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Auto-routes to best provider based on model |
| `POST` | `/:provider/v1/chat/completions` | Route to specific provider |
| `GET` | `/models` | Unified model list from all providers |
| `GET` | `/health` | Health check (detailed with auth) |

### Admin Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stats` | Full usage stats with daily history |
| `GET` | `/savings` | Cost savings breakdown (today/month/lifetime) |
| `GET` | `/smush` | Compression stats |
| `GET` | `/providers` | Provider status and key health |

### Response Headers

Every proxied response includes:

- `x-ffai-provider` — which provider handled the request
- `x-ffai-request-id` — 8-char correlation ID for log tracing
- `x-ffai-latency-ms` — total proxy latency
- `x-ffai-capacity-warning` — "low" if the provider is running hot
- `x-ffai-utilization` — current utilization ratio (0.0 – 1.0)

---

## OpenClaw Integration

FFAI includes a full TypeScript plugin for [OpenClaw](https://openclaw.com), registering as a native provider:

- **Auto-discovery** — models from all FFAI providers appear in OpenClaw's model picker
- **Provider grouping** — `ffai-gemini`, `ffai-groq`, `ffai-cerebras` etc.
- **Favorites** — curate a `ffai-favorites` group for quick access
- **`/ffai_stats`** — check savings directly from chat
- **`/ffai_encrypt`** — generate import page from chat, receive as Telegram file
- **`/ffai_import_keys`** — import an encrypted blob (user-initiated only; no auto-import hook, so pasted blobs from untrusted sources can never trigger a silent import)

---

## Quick Start

### 1. Set up keys

```bash
# .env
FFAI_KEY=your-secret-proxy-key
FFAI_ADMIN_KEY=your-admin-key
GEMINI_API_KEYS=key1,key2,key3,key4,key5
GROQ_API_KEYS=key1,key2,key3
```

### 2. Configure providers

```json
{
  "providers": {
    "gemini": {
      "upstream_url": "https://generativelanguage.googleapis.com/v1beta/openai",
      "keys_var": "GEMINI_API_KEYS",
      "auth_scheme": "bearer"
    },
    "groq": {
      "upstream_url": "https://api.groq.com/openai",
      "keys_var": "GROQ_API_KEYS",
      "auth_scheme": "bearer"
    }
  }
}
```

### 3. Start

```bash
node serve.js
# or
docker compose up -d
```

### 4. Point your app

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8010/v1",
    api_key="your-secret-proxy-key"
)

response = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

That's it. Your app thinks it's talking to OpenAI. FFAI handles everything else.

---

## Numbers

| Metric | Value |
|--------|-------|
| Dependencies | **0** |
| Lines of code | **~8,000** |
| Proxy overhead | **< 5ms** median |
| Configured providers | **5** (Gemini, Groq, Cerebras, Ollama, SambaNova — extensible to any OpenAI-compat) |
| Auth schemes | **4** (bearer, header, query, none) |
| Scoring factors | **7** per key selection |
| Circuit breaker levels | **2** (per-key + per-provider) |
| Import crypto | **ECDH P-256 + HKDF-SHA256 + AES-256-GCM** (v2, public-key) |
| Security findings fixed | **18/18** |
| Max tracked models | **2,000** (LRU) |
| Max tracked IPs | **100,000** (stale-first eviction) |
| Stats retention | **7 days** rolling |

---

*FFAI v0.3.0 — because the best AI API key is the one you don't pay for.*
