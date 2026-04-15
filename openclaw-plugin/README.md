# FFAI OpenClaw Plugin

OpenClaw provider plugin for [FFAI](https://github.com/truewebmaster/ffai) — a
zero-dependency, free-tier AI key-pooling proxy.

The plugin discovers the models FFAI is currently serving, registers one
OpenClaw provider per backend (`ffai-gemini`, `ffai-groq`, `ffai-cerebras`,
`ffai-ollama`, …), and optionally groups your favourite models into a
virtual `ffai-favorites` provider. Models refresh on every OpenClaw catalog
cycle, so adding a new backend to FFAI surfaces it automatically.

## What it adds to OpenClaw

- **One provider per FFAI backend.** Backends are grouped by the `provider`
  field FFAI returns in `/models`, and each group becomes its own OpenClaw
  provider so you can pin individual models with `/model ffai-groq/kimi-k2`.
- **Favourites group.** Configure a list of model IDs and the plugin
  publishes them under a virtual `ffai-favorites` provider. The first entry
  is promoted to the agent default during onboarding.
- **Three slash commands.** `/ffai_stats`, `/ffai_encrypt`, and
  `/ffai_import_keys` (see below).
- **Wipe protection.** If FFAI goes unreachable or returns zero models, the
  plugin refuses to overwrite the previously-known catalog — your existing
  model state survives transient FFAI restarts.
- **SSRF-hardened fetches.** Every outbound request to FFAI goes through the
  OpenClaw SDK's SSRF guard, pinned to the configured baseUrl hostname.

## Install

Drop the plugin into your OpenClaw extensions directory (either copy or
symlink for development):

```bash
# Copy
cp -r openclaw-plugin ~/.openclaw/extensions/ffai

# Or symlink
ln -s /path/to/ffai/openclaw-plugin ~/.openclaw/extensions/ffai
```

Then run the OpenClaw setup wizard:

```bash
openclaw configure
```

Pick **FFAI** from the provider list and paste your FFAI API key when
prompted. The wizard writes the provider shell into `openclaw.json` and,
if you've pre-configured favourites, sets the first one as your default
model. Do **not** hand-edit `openclaw.json` to add the provider — the
plugin owns that section and discovery will overwrite stale entries.

## Configure

All configuration is optional beyond the API key. Settings can be supplied
through `openclaw configure`, environment variables, or `openclaw.json`
under `plugins.entries.ffai.config`. Environment variables win over
`openclaw.json` values so you can override per-host without editing files.

### Environment variables

| Variable         | Default                     | Purpose                                               |
|------------------|-----------------------------|-------------------------------------------------------|
| `FFAI_KEY`       | —                           | FFAI API key used for `/models` discovery and stats. |
| `FFAI_URL`       | `http://127.0.0.1:8010`     | FFAI server URL. Overrides the plugin `baseUrl`.     |
| `FFAI_ADMIN_KEY` | —                           | Admin key required by `/ffai_encrypt` to generate the encrypted import page. Only set if you run key-import flows. |

### Plugin config (`plugins.entries.ffai.config`)

```json
{
  "plugins": {
    "entries": {
      "ffai": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8010",
          "favorites": [
            "gemini-2.5-pro",
            "gemma-4-31b-it",
            "qwen3-coder:480b",
            "moonshotai/kimi-k2-instruct-0905"
          ]
        }
      }
    }
  }
}
```

`favorites` entries are bare model IDs; they're resolved against the
discovered catalog on each refresh and missing ones are logged rather
than silently dropped.

## Slash commands

### `/ffai_stats`
Prints compression, usage, and cost-avoided stats from FFAI's `/savings`
endpoint. Requires `FFAI_KEY`.

### `/ffai_encrypt`
Generates `ffai_encrypt.html` — a single-file, browser-side encryption page
you open locally, paste API keys into, and copy the resulting
`FFAI-IMPORT:...` blob from. Requires `FFAI_ADMIN_KEY`. The HTML is
written atomically to `${tmpdir}/openclaw/ffai_encrypt.html` and surfaced
via the chat channel's `mediaUrl`.

### `/ffai_import_keys <blob>`
Posts an `FFAI-IMPORT:` blob to FFAI's `/import` endpoint for
server-side decryption and storage.

**Security:** this command is user-initiated only. The plugin does not
register any hook that auto-invokes it on incoming message content —
`FFAI-IMPORT:` strings pasted from untrusted sources (web pages, other
users, agent-read documents) never trigger key import without an explicit
`/ffai_import_keys` invocation by the operator. Blobs must start with the
literal `FFAI-IMPORT:` prefix; bare base64 payloads are rejected.

## Telegram usage

```
/models                             → lists ffai-gemini, ffai-groq, ffai-favorites, …
/models ffai-favorites              → shows your curated favourite models
/model ffai-gemini/gemini-2.5-pro   → switch to a specific model
/ffai_stats                         → compression & savings stats
```

## How it works

1. On each OpenClaw catalog refresh, the plugin's `discovery.run()` hook
   fires.
2. It `GET`s `${baseUrl}/models` with `Bearer ${FFAI_KEY}`, through the
   SDK SSRF guard pinned to the configured hostname.
3. The response is validated at the boundary (every field re-checked at
   runtime — no blind `as` casts on network data). Invalid records are
   dropped.
4. Models are grouped by their source provider and alphabetised for
   stable output.
5. Each group becomes an OpenClaw provider (`ffai-<slug>`) with
   `api: "openai-completions"` pointed at `${baseUrl}/${provider}/v1`.
6. If `favorites` is set, a `ffai-favorites` virtual provider is built
   from the matching discovered entries. Unresolved favourites are
   logged; the `ffai-favorites` key is reserved so no real backend can
   collide with it.
7. Wipe protection kicks in if the fetch returned 0 models, a non-ok
   HTTP status, or was unreachable — the live catalog is preserved.

## Troubleshooting

- **`/models` shows no `ffai-*` providers.** Check that FFAI is reachable
  on `FFAI_URL` and `FFAI_KEY` is set. Discovery logs warnings via the
  OpenClaw host logger under the `[ffai]` tag.
- **A model ID I listed under `favorites` isn't showing up.** The plugin
  logs `[ffai] favorites not found in discovered catalog: …` whenever a
  favourite ID doesn't match anything FFAI is serving — typically a typo
  or a model FFAI hasn't registered yet.
- **Stale model persists after removing it from FFAI.** OpenClaw reloads
  the catalog on its own cadence; `SIGHUP` or restart the OpenClaw
  gateway to force a refresh.
