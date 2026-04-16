# FFAI OpenClaw Plugin

OpenClaw provider plugin for [FFAI](https://github.com/truewebmaster/ffai) — a
zero-dependency, free-tier AI key-pooling proxy.

The plugin discovers the models FFAI is currently serving, registers one
OpenClaw provider per backend (`ffai-gemini`, `ffai-groq`, `ffai-cerebras`,
`ffai-ollama`, `ffai-sambanova`, …), and optionally groups your favourite
models into a virtual `ffai-favorites` provider. Models refresh on every
OpenClaw catalog cycle, so adding a new backend to FFAI surfaces it
automatically.

## What it adds to OpenClaw

- **One provider per FFAI backend.** Backends are grouped by the `provider`
  field FFAI returns in `/models`, and each group becomes its own OpenClaw
  provider so you can pin individual models with `/model ffai-groq/kimi-k2`.
- **Favourites group.** Configure a list of model IDs and the plugin
  publishes them under a virtual `ffai-favorites` provider. The first entry
  is promoted to the agent default during onboarding.
- **Three slash commands.** `/ffai_stats`, `/ffai_encrypt`, and
  `/ffai_import_keys` (see [Slash commands](#slash-commands)).
- **Per-provider key-format validation.** A Groq key accidentally dropped
  into the Gemini pool is rejected at import time, never silently trips
  circuit breakers.
- **Public-key crypto for key import.** The encrypt HTML page contains no
  decryption secret — see [Security model](#security-model).
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

| Variable         | Default                     | Purpose                                                                 |
|------------------|-----------------------------|-------------------------------------------------------------------------|
| `FFAI_KEY`       | —                           | FFAI API key used for `/models` discovery and stats.                    |
| `FFAI_URL`       | `http://127.0.0.1:8010`     | FFAI server URL. Overrides the plugin `baseUrl`.                        |
| `FFAI_ADMIN_KEY` | —                           | Admin key required by `/ffai_encrypt` to generate the import page. Only set if you run key-import flows. |

FFAI itself honours a few more knobs you may want to set before the gateway
starts — they don't live in the plugin but directly affect what the plugin
sees:

| FFAI-side variable         | Default    | Effect on the plugin                                                                                     |
|----------------------------|------------|----------------------------------------------------------------------------------------------------------|
| `FFAI_MIN_CONTEXT_WINDOW`  | `32768`    | Drops any discovered model below this context size. Set to `131072` to hide 32K-only SambaNova models that would be useless for agent work. |
| `FFAI_MIN_TPM`             | `20000`    | Drops models whose provider-level TPM is below this, so an agent turn can actually fit.                  |

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
            "qwen3-coder:480b"
          ],
          "compatSync": true
        }
      }
    }
  }
}
```

| Key          | Type       | Default | Meaning                                                                                                                                            |
|--------------|------------|---------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `baseUrl`    | `string`   | `http://127.0.0.1:8010` | FFAI server URL. Overridden by `FFAI_URL` env var.                                                                          |
| `favorites`  | `string[]` | `[]`    | Bare model IDs to group under `ffai-favorites`. The first entry is promoted to the agent default during onboarding. Missing IDs are logged, not silently dropped. |
| `compatSync` | `boolean`  | `true`  | Runs a one-shot catalog sync at gateway start to work around an upstream OpenClaw packaging bug. See [Compatibility sync](#compatibility-sync-temporary-workaround). Leave on unless your host has the upstream fix. |

## Slash commands

### `/ffai_stats`

Prints compression, usage, and cost-avoided stats from FFAI's `/savings`
endpoint. Requires `FFAI_KEY`.

```
FFAI Usage & Savings
━━━━━━━━━━━━━━━━━━━━━━━━━
Today:
  127 requests · 340K tokens (in: 280K, out: 60K)
  💰 Cost avoided: $1.42
...
```

### `/ffai_encrypt`

Generates a self-contained HTML page that encrypts keys in the browser to
FFAI's ECDH P-256 public key. Requires `FFAI_ADMIN_KEY`.

The page is written atomically to `${tmpdir}/openclaw/ffai_encrypt.html`
(mode `0600`) and surfaced via the chat channel's `mediaUrl` — on Telegram
it arrives as a file attachment. Open it in a browser, paste keys, hit
**Encrypt**, copy the `FFAI-IMPORT:...` blob, and paste it back with
`/ffai_import_keys`.

**The HTML contains no decryption secret.** See [Security model](#security-model)
for why this matters. The page shows a live countdown — blobs older than
24 hours are refused at `/import`.

**Auto-detect.** The page's default is "Auto-detect (recommended)" — it
reads the key format and picks the right provider. You can still override
manually; mixed-provider batches are rejected.

### `/ffai_import_keys <blob>`

Posts an `FFAI-IMPORT:` blob to FFAI's `/import` endpoint. FFAI decrypts
with its private key, validates each key against the detected provider's
format, and writes the surviving keys into `config.json` under
`providers.<name>.keys[]`. A `SIGHUP` is sent to the FFAI process so the
pool picks up the new keys without a restart.

Reported back in chat:

```
Keys imported successfully! 3 key(s) added for provider "gemini"
  (1 duplicate(s) skipped, 2 did not match "gemini" format)
```

- `imported` — added to the pool
- `duplicates` — already present, skipped
- `invalid` — too short to be a key (< 8 chars)
- `mismatched` — valid-looking but wrong format for the declared provider

**Security: this command is user-initiated only.** The plugin does not
register any hook that auto-invokes it on incoming message content. An
`FFAI-IMPORT:` string pasted from an untrusted source (web page scraped
by an agent, another user's message, a document the model is reading)
cannot trigger key import without you explicitly typing `/ffai_import_keys`.
Blobs must start with the literal `FFAI-IMPORT:` prefix; bare base64
payloads are rejected.

## Security model

This section matters — read it if you're going to use the key-import flow
in a shared chat.

### Threat model

The import channel (Telegram, OpenClaw transcript, anything that routes
the generated HTML and the encrypted blob through the same transport) is
**not trusted** to keep the keys secret. The transport may log, mirror,
back up, or otherwise persist messages outside your control.

The FFAI host itself **is** trusted — its filesystem holds the provider
keys in plaintext already, so its compromise is equivalent to direct key
theft.

### How the v2 flow works (current)

1. At first boot, FFAI generates a persistent ECDH P-256 keypair and stores
   it in `config.json` under `import_keypair`. The private half never
   leaves the host.
2. `/ffai_encrypt` bakes the **public** half into the HTML page. The HTML
   contains no decryption secret.
3. The browser generates an ephemeral keypair, performs ECDH with FFAI's
   public key, derives an AES-256-GCM key via HKDF-SHA256, and encrypts
   the payload. The ciphertext carries the browser's ephemeral public key
   so FFAI can redo the ECDH; a random 18-byte nonce inside the plaintext
   anchors replay protection.
4. `/ffai_import_keys` posts the blob. FFAI decrypts with its private
   key, checks the nonce hasn't been seen before (24h memory), checks the
   timestamp is within the 24h window, validates the keys, and writes
   them into the pool.

**Attacker with only the blob:** cannot decrypt — needs FFAI's private key.

**Attacker with the blob AND the HTML file:** also cannot decrypt — the
HTML contains a public key, not a secret. This was the critical fix over
the pre-upgrade design.

**Attacker with an active session on your chat during the import:** can
see the pasted keys in the textarea before encryption runs. Nothing fixes
this class of attack short of running the crypto on a separate trusted
device.

**Attacker who compromises the FFAI host:** owns everything — the
provider keys are already in plaintext there. `import_keypair` is not a
separate perimeter.

### Rate limits and replay protection

- **Per-IP rate limit.** `/import` accepts at most 10 attempts per minute
  per IP. Excess attempts get 429 and are logged.
- **Brute-force lockout.** Repeated 401/403 responses (including failed
  imports) trigger the global auth brute-force guard, which blocks the IP
  for 5 minutes after 10 failures.
- **Nonce memory.** Successful imports record the plaintext nonce for 24
  hours. Re-submitting the same blob returns 403.
- **Freshness check.** Blobs with a timestamp older than 24h or more than
  60 seconds in the future are rejected.

### v1 legacy path

Blobs generated with the pre-upgrade shared-secret flow are still accepted
for backward compatibility during the 24h TTL window after an upgrade. All
new HTML pages emit v2 blobs; you can forget v1 exists once your
outstanding tokens have expired.

### Audit log

Every `/import` attempt lands in `${configDir}/import-audit.log` (JSONL,
one event per line). Events include:

| `event`              | `reason`          | Meaning                                          |
|----------------------|-------------------|--------------------------------------------------|
| `import_success`     | —                 | Keys written to pool                             |
| `import_empty`       | —                 | No new keys (all duplicates/invalid/mismatched)  |
| `import_failed`      | `decrypt_failed`  | Ciphertext didn't authenticate                   |
| `import_failed`      | `replay`          | Nonce already seen                               |
| `import_failed`      | `stale_blob`      | Timestamp outside 24h window                     |
| `import_failed`      | `bad_ephpub`      | Malformed ephemeral public key (v2)              |
| `import_failed`      | `missing_nonce`   | v2 plaintext had no nonce                        |
| `import_failed`      | `expired_token`   | v1 token older than 24h                          |
| `import_failed`      | `unknown_token`   | v1 token doesn't match any issued                |
| `import_rate_limited`| —                 | IP exceeded 10 attempts/min                      |

## Key-format requirements

The server rejects import attempts where the key doesn't match the declared
provider's format. These are the patterns:

| Provider    | Pattern                                                 | Example                                                  |
|-------------|---------------------------------------------------------|----------------------------------------------------------|
| `gemini`    | `AIza` + 35 URL-safe chars                              | `AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`                |
| `groq`      | `gsk_` + 52 alphanumeric                                | `gsk_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` |
| `cerebras`  | `csk-` + 40+ lowercase alphanumeric                     | `csk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`   |
| `ollama`    | 32 hex, dot, 20+ alphanumeric                           | `0123456789abcdef0123456789abcdef.XXXXXXXXXXXXXXXXXXXXXXXX` |
| `sambanova` | standard UUID (`8-4-4-4-12`)                            | `00000000-0000-0000-0000-000000000000`                   |

Providers without a pattern fall through to the old length-only check
(`length >= 8`). Add new providers to `PROVIDER_KEY_PATTERNS` in `serve.js`
and the matching `KEY_PATTERNS` constant in `generateImportHtml` to lock
them down.

## Telegram usage

```
/models                             → lists ffai-gemini, ffai-groq, ffai-favorites, …
/models ffai-favorites              → shows your curated favourite models
/model ffai-gemini/gemini-2.5-pro   → switch to a specific model
/ffai_stats                         → compression & savings stats
/ffai_encrypt                       → get the import HTML page (as file)
/ffai_import_keys FFAI-IMPORT:...   → import encrypted keys
```

## Where keys end up

Keys imported via `/ffai_import_keys` land in FFAI's `config.json` under
`providers.<name>.keys[]`. On each boot, FFAI's pool also reads
`providers.<name>.keys_var` — a reference to an environment variable that
holds a comma-separated list of keys. Both sources are merged: env-sourced
keys load first, imported keys append.

If you back up `config.json`, you back up:

- All imported keys (plaintext)
- The `import_keypair` (both halves)
- Any live `import_tokens` (v1 legacy)

Restoring to a new host: both halves of `import_keypair` come along, so
any v2 HTML pages you've generated are still valid on the new host. If
you *want* to invalidate outstanding pages (e.g. after a suspected leak),
delete the `import_keypair` object from `config.json` and restart FFAI —
a fresh keypair is generated on next boot and all old blobs will fail
`decrypt_failed`.

## How it works

1. On each OpenClaw catalog refresh, the plugin's `providerDiscoveryEntry`
   catalog hook fires. (See [Compatibility sync](#compatibility-sync-temporary-workaround)
   below for the one-shot shim that runs in parallel during the upstream
   broken window.)
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

### Context window accuracy

FFAI's model discovery enriches the catalog with real context-window sizes
where the upstream provider exposes them:

- **Gemini:** native specs fetched via `generativelanguage.googleapis.com`.
- **Groq:** `context_window` returned directly in `/models`.
- **SambaNova:** `context_length` returned directly in `/models`.
- **Ollama:** `/api/show` per-model fetch returns the actual
  `*.context_length` from the model metadata. This is the only reliable
  source — Ollama's OpenAI-compatible `/v1/models` returns no specs.
- **Cerebras:** no API-side metadata. The plugin defaults to 128K, which
  matches Cerebras's published per-model limits.

Why this matters: a model advertised with the wrong context window causes
OpenClaw to send oversized prompts and get 400s back from the provider —
the agent then loops through model fallbacks until it gives up. If you see
unexplained fallbacks on a specific model, check the `contextWindow` value
in `openclaw.json` under `models.providers.ffai-<name>.models[]`.

## Troubleshooting

- **`/models` shows no `ffai-*` providers.** Check that FFAI is reachable
  on `FFAI_URL` and `FFAI_KEY` is set. Discovery logs warnings via the
  OpenClaw host logger under the `[ffai]` tag.
- **A model ID I listed under `favorites` isn't showing up.** The plugin
  logs `[ffai] favorites not found in discovered catalog: …` whenever a
  favourite ID doesn't match anything FFAI is serving — typically a typo,
  a model filtered out by the minimum-context-window or minimum-TPM gates,
  or a model FFAI hasn't registered yet.
- **A model I expect is missing from the catalog.** FFAI drops models
  below `FFAI_MIN_CONTEXT_WINDOW` (default 32K, recommended 131072 for
  agent work) and below `FFAI_MIN_TPM` (default 20K). Check FFAI's
  `[discovery]` log lines — it reports drop counts per provider.
- **Import says "X key(s) did not match format".** The server validated
  each key against the declared provider's regex and found mismatches.
  Use Auto-detect on the HTML page, or check the [Key-format requirements](#key-format-requirements)
  table.
- **"import failed — blob could not be decrypted" right after upgrading.**
  You're trying to import a v1 blob with an HTML page generated before
  the v2 upgrade, on a host that has since regenerated its keypair.
  Generate a fresh page with `/ffai_encrypt` and try again.
- **Stale model persists after removing it from FFAI.** OpenClaw reloads
  the catalog on its own cadence; `SIGHUP` or restart the OpenClaw
  gateway to force a refresh.
- **`/ffai_stats` returns 403.** `FFAI_KEY` is wrong or missing.
  `/ffai_encrypt` returns 403 means `FFAI_ADMIN_KEY` is wrong or missing
  (the two are distinct — stats uses the user key, encrypt uses admin).

## Compatibility sync (temporary workaround)

Current OpenClaw hosts have a packaging issue that prevents
`providerDiscoveryEntry` plugins — this one included — from being loaded
at gateway start (see upstream tracking issue
[`openclaw/openclaw#65715`](https://github.com/openclaw/openclaw/issues/65715)).
Until the fix ships, the plugin includes a narrowly-scoped compatibility
service that performs the same catalog sync the native discovery hook
would have performed. It fires exactly **once** at gateway start — no
polling loop — and produces the same `openclaw.json` state the native
path would produce, so the two paths are idempotent when both are
working.

**Self-disabling.** The native discovery hook writes a heartbeat marker
at `<workspaceDir>/.plugin-state/ffai-compat-sync/catalog-heartbeat.json`
every time it runs. If the shim's `start()` hook sees a heartbeat that
was written during the current gateway process (younger than process
uptime), it concludes the native path is healthy and skips the sync.
No user action is needed when upstream ships — the shim goes dormant on
its own at the next gateway restart.

**Manual override.** If you want to disable the shim explicitly (for
example, you've verified your host has the upstream fix), set
`compatSync: false` under the plugin config:

```json
{
  "plugins": {
    "entries": {
      "ffai": {
        "enabled": true,
        "config": {
          "compatSync": false
        }
      }
    }
  }
}
```

**Wipe protection.** The shim only writes when FFAI returns a populated
catalog. Empty, HTTP-error, and unreachable results never overwrite a
live `openclaw.json` — same policy as the native discovery hook.

**Allowlist sync.** The shim also writes discovered model refs into
`agents.defaults.models` when that section is non-empty — otherwise your
curated allowlist would block newly-discovered ffai models from appearing
in `/models`. Nothing is removed from the allowlist; only added.

**Auth during the workaround window.** The shim syncs the model catalog
only; it does not write auth profiles. `openclaw configure` may fail to
onboard FFAI until upstream ships. In the meantime, set `FFAI_KEY` in
the environment before starting the gateway — the plugin's synthetic
auth path uses it directly, and once the catalog sync runs you can use
any `ffai-*` model. When upstream ships, `openclaw configure` starts
working again with no migration needed.
