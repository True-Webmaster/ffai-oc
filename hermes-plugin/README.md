# FFAI Hermes Plugin

Registers FFAI's free-tier providers as Hermes [custom_providers](https://hermes-agent.nousresearch.com/docs/integrations/providers) so they appear in `hermes model` alongside built-in providers like OpenRouter and Anthropic.

## What it does

Reads FFAI's `/models` endpoint, groups by upstream provider (gemini, groq, …), and writes one `custom_providers` entry per group into `~/.hermes/config.yaml`. Hermes then auto-discovers models for each provider via `<base_url>/models` on demand — the plugin never embeds a model list, so adding/removing free-tier models in FFAI doesn't require a re-sync.

```yaml
# ~/.hermes/config.yaml after `ffai-hermes install`
custom_providers:
  - name: ffai-gemini
    base_url: http://127.0.0.1:8010/gemini/v1
    key_env: FFAI_KEY
    api_mode: chat_completions
  - name: ffai-groq
    base_url: http://127.0.0.1:8010/groq/v1
    key_env: FFAI_KEY
    api_mode: chat_completions
```

## Install

```bash
# From the FFAI repo root, after `node serve.js` is running:
node hermes-plugin/bin/ffai-hermes.js install --key $FFAI_KEY
```

Or if installed via npm:

```bash
npm install -g @ffai/hermes-plugin
ffai-hermes install --key $FFAI_KEY
```

`install` does two things:
1. Discovers FFAI providers via HTTP and upserts `custom_providers` entries in `~/.hermes/config.yaml`.
2. Writes `FFAI_KEY=<value>` into `~/.hermes/.env`.

Both writes are atomic and preserve every other line in their respective files (including YAML comments).

## Refresh the catalog

```bash
ffai-hermes sync
```

`sync` is `install` without the `.env` write. Run it after adding a new free-tier provider to FFAI's `config.json` — the new `ffai-<name>` entry appears in `hermes model`'s picker on next launch.

## Remove

```bash
ffai-hermes uninstall
```

Removes every `custom_providers` entry whose `name` starts with `ffai-`. Leaves `~/.hermes/.env` untouched (the `FFAI_KEY` value may be referenced by other tools).

## Configuration

| Source | Field | Default |
|---|---|---|
| `--url` flag | bridge base URL | — |
| `$FFAI_URL` | bridge base URL | — |
| (built-in) | bridge base URL | `http://127.0.0.1:8010` |
| `--key` flag | auth key | — |
| `$FFAI_KEY` | auth key | (no auth) |
| `$HERMES_HOME` | Hermes config dir | `~/.hermes` |

## Safety

- **Wipe protection.** `sync` and `install` refuse to write when FFAI returns zero providers, an HTTP error, or is unreachable — a transient bridge restart will not erase Hermes's view of the catalog mid-session.
- **Atomic writes.** Both `config.yaml` and `.env` are written via tmpfile + fsync + rename. A power loss between write and rename can never publish a zero-byte file.
- **Cross-process lock.** `config.yaml` operations acquire a `mkdir`-based lock with 60s stale detection, so concurrent `ffai-hermes` invocations and editor saves don't interleave reads and writes.
- **Comment preservation.** YAML comments and key ordering are preserved across writes. The first install/sync produces a one-time cosmetic reformat outside the `custom_providers:` block (escaped unicode is rewritten to raw UTF-8, long quoted strings are reflowed) because `yaml`'s Document API normalizes string serialization on emit. No data is lost — Hermes parses both forms identically — and subsequent syncs are byte-stable. See [`lib/yaml-io.js`](lib/yaml-io.js) for details.

## Architecture

This plugin is purely a config writer. Unlike the OpenClaw plugin, it has **no runtime** — Hermes loads its config at startup and queries `<base_url>/models` itself when it needs the model list. The plugin's only job is to keep `custom_providers` in sync with what FFAI is currently serving.

The OpenClaw plugin lives at [`../openclaw-plugin`](../openclaw-plugin/) and uses OpenClaw's plugin SDK to register slash commands plus run a runtime catalog sync into `openclaw.json`. Hermes has no such SDK, so this plugin is correspondingly smaller.

## Requirements

- Node ≥ 18
- A running FFAI bridge (this plugin doesn't start one; install FFAI itself first)
- Hermes Agent installed (the plugin only writes to `~/.hermes/` — it doesn't verify Hermes is present)

## License

MIT
