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
- **Four slash commands.** `/ffai_stats`, `/ffai_encrypt`,
  `/ffai_import_keys`, and `/ffai_doctor` (see [Slash commands](#slash-commands)).
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

## Quick install

This is the explicit step-by-step. If you skip a step or do them in the
wrong order, run [`/ffai_doctor`](#ffai_doctor) afterwards — it will tell
you exactly which invariant is broken.

### 1. Install FFAI itself

The plugin needs FFAI running on a reachable host (default: `127.0.0.1:8010`).
See the top-level FFAI README for installation. Verify FFAI is up before
continuing:

```bash
curl -s -H "Authorization: Bearer $FFAI_KEY" http://127.0.0.1:8010/health
# expected: {"status":"ok",...}
```

### 2. Install the plugin

Copy or symlink the plugin into your OpenClaw extensions directory:

```bash
# Copy (production)
cp -r openclaw-plugin ~/.openclaw/extensions/ffai

# Or symlink (development — picks up edits without re-copying)
ln -s /path/to/ffai/openclaw-plugin ~/.openclaw/extensions/ffai
```

### 3. Allow and enable the plugin

In `~/.openclaw/openclaw.json`, ensure `ffai` is in `plugins.allow` and
the entry is enabled:

```json
{
  "plugins": {
    "allow": ["ffai"],
    "entries": {
      "ffai": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8010",
          "favorites": []
        }
      }
    }
  }
}
```

### 4. Set gateway environment variables

The gateway process reads env at startup. Set these in the gateway's
`.env` file or systemd unit (NOT just your shell — the gateway won't see
shell-only vars):

| Variable         | Required for                              |
|------------------|-------------------------------------------|
| `FFAI_KEY`       | Catalog discovery, `/ffai_stats`          |
| `FFAI_URL`       | Optional — defaults to `http://127.0.0.1:8010` |
| `FFAI_ADMIN_KEY` | `/ffai_encrypt` only                      |

### 5. Restart the gateway

Without restart, the gateway is still running the old environment and
won't see your new env vars. This is the single most common cause of
post-install confusion:

```bash
systemctl --user restart openclaw-gateway
# or however your installation manages the gateway process
```

### 6. Verify with /ffai_doctor

In any OpenClaw chat (Telegram, web, CLI), run:

```
/ffai_doctor
```

You should see eight `✓ ok` lines and a `Summary: 8 ok · 0 warn · 0 fail · …`
footer. If anything is `✗ fail`, the line right below it tells you what
to fix. Common first-install failures:

- **`✗ FFAI_KEY in gateway env: missing`** — env var isn't visible to the
  running gateway. Either it isn't set at all, or you set it after the
  gateway started. Set it in the gateway's environment, restart, retry.
- **`✗ FFAI providers configured`** — FFAI's own `config.json` has zero
  providers. Add at least one provider stanza (Gemini, Groq, Cerebras,
  Ollama, SambaNova) and restart FFAI. See FFAI's `config.json.example`.
- **`✗ FFAI keys configured`** — providers exist but have zero keys. Set
  the matching `keys_var` env vars (e.g. `GEMINI_KEYS=...,...`) and
  restart FFAI, OR use `/ffai_encrypt` → `/ffai_import_keys` to import
  via the encrypted blob flow.
- **`✗ openclaw.json catalog-sync`** — the plugin's catalog-sync hasn't
  populated `models.providers.ffai-*` yet. Restart the gateway after
  FFAI is reachable. Check `journalctl --user -u openclaw-gateway` for
  `[ffai] catalog-sync:` log lines.

### 7. Try a model

Once `/ffai_doctor` is all-green:

```
/models                             → should list ffai-gemini, ffai-groq, …
/model ffai-gemini/gemini-2.5-pro   → switch to a specific FFAI model
```

If `/models` shows no `ffai-*` entries despite doctor passing, your
`agents.defaults.models` allowlist is non-empty and missing the model
refs — restart the gateway so catalog-sync's allowlist pass runs again.

## Install (legacy / opinionated)

If you used `openclaw configure` to onboard FFAI, the wizard handles
steps 3 and parts of 4 for you. It picks **FFAI** from the provider list,
prompts for an API key, writes the provider shell into `openclaw.json`,
and sets the first configured favourite as your default model. The
upgrade path from a wizard install is identical to the steps above. Do
**not** hand-edit `openclaw.json` to add the `ffai` provider — the plugin
owns that section and catalog-sync will overwrite stale entries on the
next gateway boot.

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
          "catalogSync": true
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
| `catalogSync` | `boolean` | `true`  | Run a one-shot sync of the FFAI catalog into `openclaw.json` at gateway start. This is how `models.providers.ffai-*` gets populated — see [Catalog sync](#catalog-sync). Leave on; disabling it leaves `/models` empty for FFAI providers. Legacy alias: `compatSync`. |

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

### `/ffai_doctor`

Runs preflight diagnostics for the plugin and prints OK/FAIL per check
with one-line remediation hints for any failures. Use this when
something doesn't work and you don't know which layer is at fault — the
output covers gateway env, FFAI reachability, provider configuration,
key population, catalog-sync state, and allowlist coverage.

Sample output:

```
FFAI doctor — preflight diagnostics
────────────────────────────────────────
✓ plugin loaded: this command ran, so the plugin's register() executed
✓ FFAI_KEY in gateway env: present (48 chars)
⚠ FFAI_ADMIN_KEY in gateway env: missing
    → Optional — needed only for /ffai_encrypt. If you plan to import keys
      via the encrypt page, set FFAI_ADMIN_KEY in the gateway environment
      and restart the gateway.
✓ FFAI reachable: http://127.0.0.1:8010 responded ok
✓ FFAI providers configured: 5 provider(s): gemini, groq, cerebras, ollama, sambanova
✓ FFAI keys configured: keys per provider: gemini=10, groq=3, cerebras=1, ollama=1, sambanova=1
✓ FFAI /models populated: 61 model(s) discovered
✓ openclaw.json catalog-sync: 6 ffai-* provider(s): ffai-gemini, ffai-groq, ffai-cerebras, ffai-ollama, ffai-sambanova, ffai-favorites
✓ /models allowlist coverage: 65/65 ffai-* model refs in allowlist
────────────────────────────────────────
Summary: 8 ok · 1 warn · 0 fail · 0 skipped
```

Acceptable resting state is "all-ok" with at most warnings on
`FFAI_ADMIN_KEY` (only matters if you use `/ffai_encrypt`) and the
allowlist coverage line (only matters if you actively curate
`agents.defaults.models`).

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
(`length >= 8`). To add a new provider end-to-end (regex, template,
auto-create, encrypt page integration), see
[`docs/adding-a-provider.md`](docs/adding-a-provider.md).

## Telegram usage

```
/models                             → lists ffai-gemini, ffai-groq, ffai-favorites, …
/models ffai-favorites              → shows your curated favourite models
/model ffai-gemini/gemini-2.5-pro   → switch to a specific model
/ffai_stats                         → compression & savings stats
/ffai_encrypt                       → get the import HTML page (as file)
/ffai_import_keys FFAI-IMPORT:...   → import encrypted keys
/ffai_doctor                        → preflight diagnostics (run after install)
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

1. At gateway start, the plugin's `register()` runs, registers the three
   slash commands, and kicks off [catalog sync](#catalog-sync) as a
   fire-and-forget task.
2. Catalog sync `GET`s `${baseUrl}/models` with `Bearer ${FFAI_KEY}`,
   through the SDK SSRF guard pinned to the configured hostname.
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

## FAQ

Quick answers to common gotchas. For anything not here, run
[`/ffai_doctor`](#ffai_doctor) first — it short-circuits most diagnoses.

### Why doesn't `/models` show `ffai-*` entries even though the plugin loaded?

Three likely causes, in order:

1. **catalog-sync hasn't run yet, or ran when FFAI was unreachable.**
   Restart the gateway after FFAI is up. Look for
   `[ffai] catalog-sync: wrote N ffai-* providers` in the gateway logs.
2. **`agents.defaults.models` allowlist is non-empty and missing the
   ffai-* refs.** OpenClaw treats that map as a strict allowlist when
   non-empty. catalog-sync adds entries on every run, but you have to
   restart the gateway after enabling FFAI so the sync fires.
3. **FFAI itself has no providers configured.** Run `/ffai_doctor` —
   the "FFAI providers configured" check reports zero.

### `/models` shows `ffai-*` in Telegram but not in Discord — why?

Two things to check, in order:

1. **Discord's model picker hides "local" providers.** The Discord
   channel plugin in OpenClaw silently filters out providers whose
   `baseUrl` looks like loopback (`127.0.0.1`, `localhost`,
   `0.0.0.0`). FFAI's default `baseUrl` is `http://127.0.0.1:8010`, so
   FFAI providers get hidden from Discord's `/models` even when they
   show up correctly in Telegram. Telegram doesn't apply this filter.
   See [openclaw/openclaw#35516](https://github.com/openclaw/openclaw/issues/35516)
   (closed/stale).

   **Fix:** point the plugin at FFAI via a non-loopback address.
   Options:
   - **Tailscale** (recommended): set `FFAI_URL=http://100.x.x.x:8010`
     using your FFAI host's Tailscale IP. Same security profile as
     loopback (Tailnet-only), no firewall changes needed.
   - **Private LAN IP**: `FFAI_URL=http://192.168.x.x:8010` if FFAI
     and the gateway are on the same LAN.
   - **Hostname**: any DNS name that doesn't resolve to a loopback
     address.

   After changing, **restart the gateway** so catalog-sync re-runs
   with the new baseUrl.

2. **Discord and Telegram are routed to different agents.** Per
   OpenClaw's config, channels can be bound to different agents and
   each agent computes its own model picker. catalog-sync only writes
   to `agents.defaults.models`. If your Discord channel is bound to a
   non-default agent that has its own model overrides, the FFAI
   entries we added to defaults don't propagate.

   **Fix:** either bind the Discord channel to the same agent
   Telegram uses, or copy the `ffai-*` model refs from
   `agents.defaults.models` into that agent's config manually.

   Run `/ffai_doctor` from the **Discord channel** to see exactly
   what that agent's model picker resolves to. If the doctor shows
   the expected ffai-* providers but Discord's `/models` doesn't,
   you've hit cause (1) — the localhost filter — not cause (2).

### Why does the gateway "see" `FFAI_KEY` when the rest of my shell doesn't?

The gateway process inherits whatever environment it was launched with.
If it was started by `systemd` from a unit with an `Environment=` line
or `EnvironmentFile=`, that's what it sees — independent of your
interactive shell. The reverse also bites people: setting `FFAI_KEY` in
your shell after the gateway is running has no effect, because the
gateway was started before the variable existed.

**Fix:** put env vars in the gateway's `.env` or systemd unit, not just
your shell. Then **restart the gateway**.

### I imported keys, why aren't they working yet?

The `/import` response includes a `restart_hint` field that surfaces in
chat. The flow is:

1. Keys are written to `config.json` (durable, survives restart).
2. FFAI is signaled to hot-reload via `SIGHUP`.
3. The hot-reload handler refreshes the pool with the new keys.

Hot-reload is best-effort. If step 3 silently fails (rare but possible),
the keys are on disk but the running pool doesn't know about them yet.
Restart FFAI (`systemctl restart ffai` or equivalent) and the new keys
become live.

### I changed `.env`, why doesn't FFAI / the gateway pick it up?

Both processes read environment variables at startup, not on demand.
After editing `.env`:

- For FFAI: `systemctl restart ffai`
- For the OpenClaw gateway: `systemctl --user restart openclaw-gateway`

This is the most common source of "I set X and nothing changed."

### Where do my keys live? Is `config.json` safe to back up?

Keys live in two places, **union-merged at runtime**:

- Env vars referenced by `keys_var` (e.g. `GEMINI_KEYS=key1,key2,key3`)
- `providers.<name>.keys[]` in FFAI's `config.json` (mode 0600)

Both sources are honored simultaneously. Edit either one and restart
FFAI to pick up the change.

`config.json` IS safe to back up but treat it as a secret — it contains:

- All keys imported via `/ffai_import_keys` in plaintext
- The `import_keypair` (both halves of the ECDH P-256 keypair used by
  the encrypted import flow)

If you restore to a new host, the import keypair comes along, so any
HTML pages you've generated still work. To invalidate outstanding
pages (e.g. after a suspected leak), delete the `import_keypair` field
and restart FFAI — a fresh keypair is generated and old blobs fail
`decrypt_failed`.

### I'm getting "format mismatch" — what does that mean?

The server validates every imported key against the declared provider's
regex (see [Key-format requirements](#key-format-requirements)). A
"mismatch" means the key string doesn't look like a key for that
provider. Most common causes:

- Wrong provider selected on the encrypt page (auto-detect prevents
  this; if you picked manually, double-check).
- Truncated key (paste error).
- Provider you're targeting isn't in the supported list — see the
  table in `Key-format requirements`. Truly novel providers fall
  through to a length-only check (`>= 8 chars`).

### The catalog says my model has 131K context but it's failing at 32K — why?

FFAI's discovery enriches the catalog with real context-window sizes
where the upstream API exposes them:

- **Gemini** — fetched natively from
  `generativelanguage.googleapis.com`.
- **Groq, SambaNova** — returned in `/v1/models` (Groq uses
  `context_window`, SambaNova uses `context_length`).
- **Ollama** — fetched per-model from `/api/show` (the OpenAI-compat
  `/v1/models` returns no specs).
- **Cerebras** — no API-side metadata. Defaults to 131K, which matches
  Cerebras's actual published limits across their current model set.

If you see a context-window mismatch, the most likely cause is you're
on a pre-0.4.0 FFAI where SambaNova's `context_length` field wasn't
read. Upgrade and restart.

### What's the difference between `FFAI_KEY` and `FFAI_ADMIN_KEY`?

- `FFAI_KEY` is the user-facing key — protects `/v1/chat/completions`,
  `/models`, `/savings`. The plugin uses it for catalog discovery and
  `/ffai_stats`.
- `FFAI_ADMIN_KEY` is the operator key — protects `/generate-import`
  (used by `/ffai_encrypt`) and other admin endpoints (`/stats`,
  `/providers`, `/smush`).

If `FFAI_ADMIN_KEY` isn't set, FFAI falls back to `FFAI_KEY` for admin
operations. For production, set them to different values so leaking
the user key doesn't grant admin access.

### Should I disable `catalogSync`?

No. It's the only thing populating `models.providers.ffai-*` in
`openclaw.json`. The host's native `providerDiscoveryEntry` dispatch
path doesn't fire for plugins that combine catalog discovery with a
runtime entry that registers commands — see [Catalog sync](#catalog-sync)
for the full architecture explanation. Disabling catalog-sync leaves
`/models` empty for all FFAI providers.

The opt-out exists for a hypothetical future where the upstream
dispatch starts working. Keep it on for now.

## Catalog sync

OpenClaw plugins normally publish their model catalog through the
`providerDiscoveryEntry` hook: the host loads the discovery module,
calls `catalog.run` on its own schedule, and writes the result into
`openclaw.json`. That dispatch path does not currently invoke
`catalog.run` for plugins that combine `providerDiscoveryEntry` with
a runtime entry registering slash commands — the host either runs
the discovery module without firing the runtime register (no commands)
or runs the runtime register without firing the discovery hook (no
catalog). Filing one upstream issue closed; the underlying
chicken-and-egg persists.

**Catalog sync is how this plugin populates the catalog instead.** It
runs from inside the plugin's `register()` at gateway start, fetches
FFAI's `/models`, and writes the discovered providers + allowlist
entries directly into `~/.openclaw/openclaw.json`. The on-disk shape
is identical to what the host would have written if its dispatch had
reached us, so nothing else in OpenClaw needs to know whether the
catalog came from native dispatch or from us.

Fires exactly **once** per gateway start. No periodic refresh — the
catalog stays as written until the next gateway boot. To pick up
changes from FFAI's upstream models mid-run, restart the gateway.

### Backoff retry

If FFAI is briefly unreachable when the gateway boots (common under
Docker/systemd parallel start), catalog sync retries with bounded
backoff: 5s, 10s, 30s, 60s, 120s, 120s — about 5 minutes of total
budget. After all retries exhaust, a single warn line is logged and
the catalog stays as it was; restart the gateway after FFAI is up.

### Wipe protection

Only writes when discovery returns `source: "fetched"` with a non-empty
providers map. Empty, HTTP-error, and unreachable results never
overwrite the live `openclaw.json` — a transient FFAI restart or 5xx
must not erase provider state mid-conversation.

### Allowlist sync

`agents.defaults.models` is OpenClaw's allowlist: when non-empty, only
listed model refs appear in `/models`. Catalog sync ADDS discovered
ffai-* model refs to it so newly added providers (e.g. SambaNova)
appear automatically. Never removes — manually curated entries
(including non-ffai entries) are preserved.

### Disabling

Catalog sync is on by default. Disabling it leaves `/models` empty for
FFAI providers, so it should stay on for typical use. The opt-out
exists for hosts that someday do dispatch correctly:

```json
{
  "plugins": {
    "entries": {
      "ffai": {
        "enabled": true,
        "config": {
          "catalogSync": false
        }
      }
    }
  }
}
```

The legacy key `compatSync: false` is still accepted as an alias for
backwards compatibility with pre-1.2.0 configs.

### Auth scope

Catalog sync writes the model catalog and allowlist only. It does not
write auth profiles. The plugin's synthetic-auth hook synthesises an
api-key credential from `FFAI_KEY` plus the populated baseUrl, so
completions work without an explicit `openclaw configure` step. Set
`FFAI_KEY` in the environment before starting the gateway and any
`ffai-*` model is usable as soon as the catalog is synced.

## For maintainers and AI agents

If you're editing this plugin's source (or you're an LLM helping
someone do so), see [`AGENTS.md`](AGENTS.md) for the project's coding
conventions, security boundaries, and common-question playbook. The
repo root has its own [`AGENTS.md`](../AGENTS.md) for the FFAI server
side.

Adding a new OpenAI-compatible provider? The end-to-end checklist is in
[`docs/adding-a-provider.md`](docs/adding-a-provider.md).
