# FFAI OpenClaw Plugin

OpenClaw provider plugin for [FFAI](https://github.com/truewebmaster/ffai) — free-tier AI key-pooling proxy.

## What it does

- Discovers all models from your FFAI server automatically
- Creates one OpenClaw provider per FFAI backend (`ffai-gemini`, `ffai-groq`, `ffai-cerebras`, `ffai-ollama`, etc.)
- Supports a **favorites** group — curated models that appear as `ffai-favorites` in Telegram `/models`
- Models refresh on each OpenClaw catalog cycle — add new providers to FFAI and they appear automatically

## Install

Copy this directory into your OpenClaw extensions:

```bash
cp -r openclaw-plugin/ ~/.openclaw/extensions/ffai/
```

Or symlink for development:

```bash
ln -s /path/to/ffai/openclaw-plugin ~/.openclaw/extensions/ffai
```

## Configure

### 1. Set FFAI_KEY

Add to your OpenClaw gateway environment:

```bash
# In systemd service or .env
Environment=FFAI_KEY=your-ffai-key-here
```

Or run `openclaw configure` and select FFAI.

### 2. Plugin config (optional)

In `openclaw.json` under `plugins.ffai`:

```json
{
  "plugins": {
    "ffai": {
      "baseUrl": "http://127.0.0.1:8010",
      "favorites": [
        "gemini-3.1-pro-preview",
        "gemini-2.5-pro",
        "gemma-4-31b-it",
        "qwen3-coder:480b",
        "kimi-k2:1t"
      ]
    }
  }
}
```

### 3. Restart gateway

```bash
systemctl --user restart openclaw-gateway.service
```

## Telegram usage

```
/models                     → shows ffai-gemini, ffai-groq, ffai-favorites, etc.
/models ffai-favorites      → lists your curated favorite models
/model ffai-gemini/gemini-2.5-pro  → switch to a specific model
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FFAI_KEY` | — | API key for FFAI authentication |
| `FFAI_URL` | `http://127.0.0.1:8010` | FFAI server URL (overrides plugin config) |

## How it works

1. On startup, the plugin's `discovery.run()` hook fires
2. It fetches `GET /models` from FFAI with the API key
3. Models are grouped by their source provider (gemini, groq, etc.)
4. Each group becomes an OpenClaw provider: `ffai-gemini`, `ffai-groq`, etc.
5. If favorites are configured, a `ffai-favorites` provider is created
6. All providers use FFAI's auto-routing (`/v1/chat/completions`) or direct routing (`/{provider}/v1/...`)
7. OpenClaw's model catalog system handles the rest — `/models` command, model switching, etc.
