# AGENTS.md — guidance for LLM agents working in this repo

This document is for AI agents (Claude Code, OpenClaw agents, etc.) that
end up reasoning about FFAI's codebase or runtime. Humans should read
[`README.md`](README.md) instead — it's the install/operate guide.

## What this project is

**FFAI** is a zero-dependency Node.js proxy that pools API keys for
OpenAI-compatible LLM providers (Gemini, Groq, Cerebras, Ollama,
SambaNova). It rotates across keys, learns rate limits, runs per-key
circuit breakers, and exposes a single `/v1/chat/completions` endpoint
that auto-routes by model.

The repo also contains the first-party OpenClaw plugin under
[`openclaw-plugin/`](openclaw-plugin/) — that has its own
[AGENTS.md](openclaw-plugin/AGENTS.md). Read that one if you're working
on plugin code; this one is for the FFAI server (`serve.js`, `lib/`,
`test/`).

## Repo orientation

- `serve.js` — the entire HTTP server. Routes start around line 2160.
  All non-trivial logic is at module scope; keep new code in the same
  style or move it into `lib/`.
- `lib/` — shared modules (pool, key scoring, model discovery,
  smush/compression, auth guard, config validator).
- `test/` — `node:test` integration tests. Spawn `serve.js` as a child
  process, hit it with HTTP. No mocks.
- `openclaw-plugin/` — separate npm package with its own README and
  AGENTS.md. Don't import server code from there.
- `config.json` (gitignored) — provider stanzas + import keypair +
  imported keys. **Treat as a secret.**
- `config.json.example` — committed template.
- `.env` (gitignored) — env-sourced provider keys.

## Codebase rules

These come from the project's CLAUDE.md and prior maintainer
conventions. Follow them when editing.

### Style

- **Zero dependencies.** Pure Node built-ins only (`http`, `https`,
  `crypto`, `fs`, `path`). If something needs a library, the answer is
  almost always to inline a focused implementation. Look at how the
  codebase already does HTTP, JSON Schema validation, etc.
- **No frameworks.** No Express, no Fastify, no Zod. Raw `http` server
  with a manual route dispatch table.
- **Prefer module scope over classes.** New helpers go as top-level
  functions. Classes only when there's genuine encapsulated state
  (e.g. `Pool`).
- **Single-file is fine.** `serve.js` is 2500 lines; that's by design
  for ops simplicity (one file to inspect on a production host). Don't
  split it without a strong reason.

### Comments

Default to writing none. The exceptions:
- Hidden constraint or invariant a future reader could violate.
- Workaround for a specific upstream bug — link the bug.
- Subtle security property (we have a few — see SSRF guard, key
  redaction, timing-safe auth).

Don't write comments that restate the code. Don't write
"// Added for X" or "// Used by Y" — those rot.

### Tests

- Add an integration test for any new HTTP endpoint or response field.
- Run `node --test test/import.test.js` after non-trivial server
  changes.
- Tests use a temp config and spawn serve.js fresh. Don't mock — the
  whole point of these tests is to catch real wire-format mistakes.

## Security boundaries

These are non-negotiable. Don't relax them without explicit user
direction.

### Inbound

- **Auth.** `FFAI_KEY` and `FFAI_ADMIN_KEY` use `crypto.timingSafeEqual`
  with a byte-length pre-check. Don't introduce other auth paths.
- **Brute force.** 10 failed auth attempts per IP per minute → 5-minute
  block. Lives in `authGuard`.
- **Rate limit on /import.** 10 attempts per IP per minute. Configurable
  via `FFAI_IMPORT_RATE_MAX` / `FFAI_IMPORT_RATE_WINDOW`.
- **Path traversal.** Three-layer check (raw, decoded,
  post-construction). Don't bypass.
- **Body size.** Configurable per-provider, enforced both pre-read and
  during streaming.

### Outbound

- **Header allowlist.** Both request and response headers are stripped
  to allowlists. Don't pass through arbitrary headers; add to the
  allowlist if a specific one is needed.
- **No URL construction from user input** that doesn't go through the
  hostname check at the top of `forward()`.

### Key import (`/import`)

The current design (post-0.4.0) is:
- ECDH P-256 + HKDF-SHA256 + AES-256-GCM
- Server holds the private key (`config.import_keypair`); only the
  public half goes to the browser
- Replay protection: 24h nonce memory
- Key-format validation: every imported key must match the declared
  provider's regex (`PROVIDER_KEY_PATTERNS`); mismatches are rejected
- Auto-create provider stanzas on import for known providers via
  `PROVIDER_TEMPLATES`

If you change any of this, update the openclaw-plugin's matching
copies (`KEY_PATTERNS` in `generateImportHtml`, the encrypt page's
crypto code) — the two halves of the protocol must stay in sync.

### Logging

- API keys never appear in logs. They're shown as `...xxxx` (last 4
  chars). The redactor lives in `_redactKeys()`.
- Upstream error bodies pass through `_redactKeys()` before being
  forwarded to the client.

## Things you can change freely

- Adding a new env var (follow the `envInt` / `process.env.FFAI_*`
  pattern; document in `.env.example` and `README.md`).
- Adding a new HTTP endpoint (add to the route dispatch table near
  line 2160; auth-gate appropriately).
- Adding a new provider to `PROVIDER_TEMPLATES` and
  `PROVIDER_KEY_PATTERNS` — see [`openclaw-plugin/docs/adding-a-provider.md`](openclaw-plugin/docs/adding-a-provider.md)
  for the full checklist.
- Pricing entries in `MODEL_PRICING`.

## Things to avoid

- **Don't add npm dependencies.** "Zero deps" is a load-bearing
  selling point; users install on hardened hosts where every dep is
  audited.
- **Don't break wire compatibility** with the OpenClaw plugin without
  updating the plugin too. The two ship as a pair.
- **Don't promote env-sourced keys to `config.json`.** This was a real
  bug fixed in 0.4.0 — `resolveKeys()` union-merges both sources, and
  `/import` only writes the *new* keys to config. Don't reintroduce
  the old "copy env into config on first import" behavior; it
  silently disables future env updates.
- **Don't write to `~/.openclaw/openclaw.json` from server code.** That
  file belongs to the OpenClaw gateway. The plugin's `catalog-sync`
  module is the only thing that's allowed to touch it (and only the
  `models.providers.ffai-*` and `agents.defaults.models` slices).
- **Don't add an "auto-import" hook** for `FFAI-IMPORT:` strings. Key
  import must always be user-initiated. Pasted blobs from untrusted
  sources (web pages, agent-read documents, other users) must never
  trigger import without an explicit `/ffai_import_keys` invocation.
- **Don't silently fall back on validation failures.** If config is
  invalid, log the error and fail closed. The user can then fix it.

## Common questions you'll be asked

If a user asks one of these, here's the short answer:

| Question | Answer |
|---|---|
| "Why isn't model X available?" | Run `/ffai_doctor` (the OpenClaw plugin slash command). It checks every layer. |
| "I changed `.env`, why doesn't it work?" | Gateway reads env at startup. **Restart the gateway.** |
| "Where are my keys stored?" | `config.json` (mode 0600) plus whatever `keys_var` env vars resolve to. Both are merged at runtime. |
| "Is hot-reload reliable?" | Best-effort. The `/import` response includes `restart_hint` — if hot-reload silently fails, restart FFAI. |
| "Why does my model say 131K context but fail at 32K?" | Discovery enriches context windows from upstream APIs. Some providers (Cerebras, Ollama via OpenAI-compat) don't expose specs, so we default to 131K. SambaNova's DeepSeek-V3.2 is actually 32K. |

## When in doubt

The two highest-traffic files are `serve.js` (server) and
`openclaw-plugin/catalog-sync.ts` (catalog publication). Read them
before making structural changes. Both have detailed module-level
header comments explaining design intent.
