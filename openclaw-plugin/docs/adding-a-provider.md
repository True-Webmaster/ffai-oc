# Adding a new provider

This walks through everything needed to add a new OpenAI-compatible LLM
provider to FFAI + the OpenClaw plugin. End-to-end the change touches
4–5 files and is mechanical once you have the provider's API details.

The five built-in providers (Gemini, Groq, Cerebras, Ollama, SambaNova)
are the templates — copy whichever is closest in shape to what you're
adding.

## Prerequisites you need from the provider

Before starting, gather:

| Need | Why |
|---|---|
| **Upstream base URL** for OpenAI-compat completions | Feeds `upstream_url` in the provider stanza. Example: `https://api.groq.com/openai`. |
| **Auth scheme** — `bearer` / `header` / `query` | Most modern providers are `bearer` (`Authorization: Bearer <key>`). |
| **API key format** — typical prefix and length | Used to validate imported keys and prevent mislabeled keys from poisoning the pool. Look at 2-3 real keys. |
| **Free-tier rate limits** — RPM / TPM / RPD | Feeds smart scoring and circuit breakers. The provider's docs usually publish these. If unknown, set `rpm_limit: 0` to disable scoring. |
| **Whether `/v1/models` exposes context windows** | Determines if discovery enriches automatically (Groq, SambaNova) or falls back to defaults (Cerebras). |

If you don't have all of these, the plugin will still work — but the
auto-detect/auto-create paths won't, and operators will have to enter
keys for the new provider manually with the dropdown override.

## The four files to touch

### 1. `serve.js` — `PROVIDER_KEY_PATTERNS`

Validates every imported key against a regex before it lands in the
pool. A mismatched key triggers a `mismatched` count in the import
response, never enters the pool, and never trips circuit breakers
silently.

Find this block (around line 362):

```js
const PROVIDER_KEY_PATTERNS = {
  gemini:    /^AIza[A-Za-z0-9_-]{35}$/,
  groq:      /^gsk_[A-Za-z0-9]{52}$/,
  cerebras:  /^csk-[a-z0-9]{40,}$/,
  ollama:    /^[0-9a-f]{32}\.[A-Za-z0-9]{20,}$/,
  sambanova: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};
```

Add your provider:

```js
const PROVIDER_KEY_PATTERNS = {
  // ...existing...
  togetherai: /^[a-f0-9]{64}$/,  // example: 64-hex bearer key
};
```

**Make the regex tight enough to avoid collisions** with other
providers. Test at least 3 real keys against it; test a Gemini key
against it to confirm no false positive.

### 2. `serve.js` — `PROVIDER_TEMPLATES`

Used for auto-creating the provider stanza on `/import` when the user
imports keys for a provider that doesn't yet exist in `config.json`.
Without this entry, the import returns `unknown provider` and refuses.

Find this block (around line 377), and add a stanza matching what
`config.json.example` shows for similar providers:

```js
const PROVIDER_TEMPLATES = {
  // ...existing...
  togetherai: {
    keys_var: "TOGETHERAI_KEYS",
    upstream_url: "https://api.together.xyz/v1",
    auth_scheme: "bearer",
    rpm_limit: 60,                   // from provider's docs
    tpm_limit: 1000000,
    rpd_limit: 10000,
    default_cooldown: 5,
    max_cooldown: 120,
    retryable_statuses: [429, 502, 503],
    key_cb_threshold: 5,
    key_cb_cooldown: 60000,
  },
};
```

The template is what gets written to `config.json` when the operator
imports their first key. Pick limits conservatively — overshooting
will cause smart scoring to think keys are dead when they're just
underused.

### 3. `serve.js` — `generateImportHtml`'s `KEY_PATTERNS`

The encrypt page (the HTML returned by `/generate-import`) does
client-side auto-detect when the user pastes keys. The `KEY_PATTERNS`
constant inside `generateImportHtml` MUST mirror `PROVIDER_KEY_PATTERNS`
exactly — they're the same regexes, just embedded in the generated HTML
for the browser to use.

Find this block (around line 1162):

```js
const KEY_PATTERNS = [
  { provider: "gemini",    regex: /^AIza[A-Za-z0-9_-]{35}$/ },
  { provider: "groq",      regex: /^gsk_[A-Za-z0-9]{52}$/ },
  { provider: "cerebras",  regex: /^csk-[a-z0-9]{40,}$/ },
  { provider: "ollama",    regex: /^[0-9a-f]{32}\\.[A-Za-z0-9]{20,}$/ },
  { provider: "sambanova", regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
];
```

Add your provider matching the regex from step 1. Note the doubled
backslash on `ollama` — that's because the regex is inside a template
string. JS regex literals work directly:

```js
{ provider: "togetherai", regex: /^[a-f0-9]{64}$/ },
```

Also add an `<option>` to the provider dropdown earlier in
`generateImportHtml`:

```html
<option value="togetherai">Together AI</option>
```

### 4. `config.json.example`

Add a sample stanza so users cloning the repo see your provider as a
known good template:

```json
{
  "providers": {
    "togetherai": {
      "keys_var": "TOGETHERAI_KEYS",
      "upstream_url": "https://api.together.xyz/v1",
      "auth_scheme": "bearer",
      "rpm_limit": 60,
      "tpm_limit": 1000000,
      "rpd_limit": 10000,
      "default_cooldown": 5,
      "max_cooldown": 120,
      "retryable_statuses": [429, 502, 503],
      "key_cb_threshold": 5,
      "key_cb_cooldown": 60000
    }
  }
}
```

Same shape as the `PROVIDER_TEMPLATES` entry. Match them exactly so
the auto-create path produces the same stanza the example documents.

### 5. (Optional) `serve.js` — `_KEY_PATTERNS` redactor

The redactor scrubs API keys out of error responses forwarded to the
client. The patterns are looser than the import-time validators since
the goal is "catch anything that looks key-shaped" rather than precise
identification.

Find this regex (around line 441):

```js
const _KEY_PATTERNS = /\b(sk-[a-zA-Z0-9_-]{10,}|gsk_[a-zA-Z0-9]{20,}|AIzaSy[a-zA-Z0-9_-]{30,}|csk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_-]{20,})\b/g;
```

If your provider's key format isn't already covered by the generic
fallbacks (`sk-...`, `Bearer ...`), add an alternate to the alternation.
For our `togetherai` example with a 64-hex format, you'd want to add
something like `[a-f0-9]{64}` — but be careful, that pattern matches a
lot of non-key strings (commit hashes, file checksums). Tight regexes
on the redactor produce false negatives; loose ones produce false
positives that mangle legitimate output.

If unsure, leave the redactor alone. The import-time validator is the
real defense against key leakage; the redactor is just belt-and-
suspenders for upstream error messages.

## Testing

After changes:

```bash
# 1. Server syntax check
node -c serve.js

# 2. Plugin typecheck
cd openclaw-plugin && npm run typecheck

# 3. Integration tests
node --test test/import.test.js
```

Then manually:

```bash
# 4. Set a test key and start FFAI locally
TOGETHERAI_KEYS=test-key-123 node serve.js

# 5. Hit /providers to confirm your provider appears
curl -s -H "Authorization: Bearer $FFAI_KEY" http://127.0.0.1:8010/providers \
  | python3 -m json.tool | head

# 6. Hit /models — your provider's models should be discovered
curl -s -H "Authorization: Bearer $FFAI_KEY" http://127.0.0.1:8010/models \
  | python3 -c 'import sys,json; print([m["id"] for m in json.load(sys.stdin).get("data",[]) if m.get("owned_by")=="togetherai"])'

# 7. Test the encrypt page
curl -s -H "Authorization: Bearer $FFAI_ADMIN_KEY" http://127.0.0.1:8010/generate-import > /tmp/test.html
grep -c "togetherai" /tmp/test.html  # should be > 0 (option + KEY_PATTERNS)
```

For the OpenClaw plugin side:

```bash
# 8. Restart the gateway so catalog-sync picks up the new provider
systemctl --user restart openclaw-gateway

# 9. In a chat: /ffai_doctor should show your provider in
#    "FFAI providers configured" and have keys in "FFAI keys configured"
```

## Adding integration test coverage

Add a regression test in `test/import.test.js` for the new provider's
key format. The existing tests have a template at the bottom:

```js
it("creates a togetherai stanza when missing and reports it", async () => {
  // remove any existing togetherai stanza first
  const before = JSON.parse(fs.readFileSync(configFile, "utf8"));
  delete before.providers?.togetherai;
  fs.writeFileSync(configFile, JSON.stringify(before, null, 2));

  const genRes = await request("/generate-import", { headers: authHeader(ADMIN_KEY) });
  const pub = extractPubKeyFromHtml(genRes.body);

  // 64 hex chars matching the togetherai pattern
  const newKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  assert.equal(newKey.length, 64);

  const envelope = encryptPayloadV2(pub, {
    provider: "togetherai",
    keys: [newKey],
    ts: Date.now(),
    nonce: randomNonce(),
  });
  const res = await request("/import", {
    method: "POST",
    headers: { ...authHeader(ADMIN_KEY), "content-type": "application/json" },
    body: JSON.stringify({ payload: envelopeToPayload(envelope) }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.imported, 1);
  assert.equal(res.json.provider_auto_created, true);
});
```

## Documentation to update

After the code changes:

- **`openclaw-plugin/README.md` → "Key-format requirements"** — add a
  row to the table with the regex and an example key.
- **`openclaw-plugin/README.md` → "Quick install" step 4** — add the
  `TOGETHERAI_KEYS` env var if it's a likely default.
- **`README.md` (top level) → providers list** — add the provider to
  the prose.
- **`.env.example`** — add `TOGETHERAI_KEYS=` so users see the
  environment variable name.

## Sanity checks before merging

- [ ] Regex matches at least 3 real keys you've collected.
- [ ] Regex does NOT match keys from any other provider (test against
      one Gemini, one Groq, one Cerebras, one Ollama, one SambaNova
      key from the docs).
- [ ] Rate limits are pulled from the provider's published docs, not
      guessed.
- [ ] Auto-create path works in an integration test.
- [ ] `/ffai_doctor` shows the new provider as `ok` after restart.
- [ ] README "Key-format requirements" table updated.
- [ ] `config.json.example` template added.

## What NOT to do

- **Don't add the provider as a special-case in the proxy code path.**
  The whole point of the config-driven design is that new providers
  are data, not code. If you're tempted to write `if (provider ===
  "X")`, step back and figure out what config field would generalize.
- **Don't introduce a runtime dependency** on a provider's SDK. FFAI
  speaks the OpenAI-compat protocol directly with the built-in
  `http`/`https` modules. If a provider needs special handling, that
  belongs in the provider stanza (e.g. custom timeouts, special
  retryable statuses), not in a code branch.
- **Don't relax the regex to "make it work"** when keys aren't
  matching. Either the regex is wrong (fix it) or the user has a
  different key format than expected (find out which). A loose regex
  that accepts other providers' keys would silently route them
  to the wrong upstream.
- **Don't skip the redactor update if your key format is novel.** If
  the upstream returns 401 with the key echoed in the body (some do),
  not having it in the redactor means the key gets logged on the
  client side.
