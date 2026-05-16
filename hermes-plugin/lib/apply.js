/**
 * Shared upsert logic — turn an FFAI provider list into Hermes
 * custom_providers entries and merge into the YAML doc.
 *
 * Each entry takes the shape Hermes documents in its custom_providers
 * section:
 *   - name        ffai-<sanitized-provider-name>
 *   - base_url    <baseUrl>/<originalProviderName>/v1
 *   - api_key     <resolved FFAI_KEY value>   (when known at install time)
 *   - key_env     FFAI_KEY                    (kept as a hint / doc)
 *   - api_mode    chat_completions
 *
 * Why both api_key AND key_env?
 *
 * Hermes's interactive picker (the code that renders `/model` on Telegram /
 * Discord) reads `entry["api_key"]` directly in its section-4 grouping
 * (hermes_cli/model_switch.py around line 1638). It does NOT resolve
 * `key_env` to a value there, even though other code paths (line 1525)
 * do. Without `api_key`, the picker shows every ffai-* entry as
 * "(0 models)" because the live-discovery probe is gated on
 * `if api_url and api_key:`. This matches the shape Hermes's own
 * `_save_custom_provider` (main.py L3313) writes when a user runs the
 * setup wizard manually.
 *
 * The trade is a small one: the FFAI_KEY value lands in `config.yaml`
 * (chmod 600) in addition to `~/.hermes/.env`. Both files have the same
 * security boundary (single-user, 0600), so this is consistent with
 * Hermes's own conventions.
 *
 * `key_env` is preserved so:
 *   - Operators inspecting the file see the source of truth.
 *   - Future rotations via `ffai-hermes install` correctly identify
 *     ffai-* entries to update.
 *   - If Hermes ever fixes the section-4 picker to honour key_env, the
 *     file already declares it — no migration needed.
 *
 * The unsanitized provider name goes into the URL path because FFAI routes
 * by the exact name it advertised in /models — sanitization only applies to
 * the `name:` field so Hermes's custom:<name>:<model> reference syntax
 * parses cleanly.
 */
import { upsertCustomProvider, removeCustomProvidersWhere } from "./yaml-io.js";
import { sanitizeProviderName } from "./discover.js";

const FFAI_PREFIX = "ffai-";
const KEY_ENV = "FFAI_KEY";
const API_MODE = "chat_completions";

function buildEntry(providerName, baseUrl, disambiguatedName, apiKey) {
  const nameSuffix = disambiguatedName ?? sanitizeProviderName(providerName);
  // Field order matches Hermes's own writer (main.py::_save_custom_provider)
  // so a `git diff` between a wizard-written entry and a plugin-written one
  // is empty when the values agree.
  //
  // base_url intentionally omits the `/v1` suffix. Hermes appends `/models`
  // for catalog discovery and `/v1/chat/completions` for completions. Both
  // are correct against FFAI:
  //   - `<bridge>/<provider>/models`            → FFAI's curated/filtered
  //     per-provider slice (added in FFAI 0.7.0). Hermes's picker shows
  //     ~15 free-tier models instead of the ~50 raw upstream catalog,
  //     matching what openclaw-plugin sees.
  //   - `<bridge>/<provider>/v1/chat/completions` → FFAI's per-provider
  //     proxy with key rotation, unchanged.
  //
  // Older FFAI bridges (≤0.6.0) without the /<provider>/models route will
  // return 404 on Hermes's model probe and the picker will show "(0
  // models)" for ffai-* entries. Upgrade the bridge to 0.7.0 or revert
  // to hermes-plugin 0.3.0 (which appended /v1 here).
  const entry = {
    name: `${FFAI_PREFIX}${nameSuffix}`,
    base_url: `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(providerName)}`,
  };
  if (apiKey) entry.api_key = apiKey;
  entry.key_env = KEY_ENV;
  entry.api_mode = API_MODE;
  return entry;
}

/**
 * Replace the full `ffai-*` set in `doc.custom_providers` with entries derived
 * from `providers`. Non-`ffai-*` entries are preserved untouched. Returns a
 * summary of what changed.
 *
 * @param {object} doc          YAML Document from yaml-io.
 * @param {Array}  providers    Provider list from discover.js.
 * @param {string} baseUrl      FFAI bridge base URL.
 * @param {object} [opts]
 * @param {string} [opts.apiKey] Resolved FFAI_KEY value to embed as
 *   `api_key:` on every entry. When absent (e.g. an early-install where
 *   the key isn't known yet), entries are written with just `key_env:`
 *   and the user runs `install` later with `--key` to backfill.
 */
export function applyCustomProviders(doc, providers, baseUrl, opts = {}) {
  const apiKey = typeof opts.apiKey === "string" && opts.apiKey.trim()
    ? opts.apiKey.trim()
    : undefined;

  // Remove all existing ffai-* entries first — discovery is the source of
  // truth for which free-tier providers should be registered. Wipe protection
  // is enforced upstream (caller refuses to run sync against an empty
  // discovery result).
  const removed = removeCustomProvidersWhere(doc, (name) => name.startsWith(FFAI_PREFIX));

  // Track sanitized-name collisions so two FFAI providers that sanitize
  // to the same custom_providers `name` (e.g. "Groq!" and "groq?") don't
  // silently clobber each other. Second collision gets a "-2" suffix,
  // third "-3", etc. The URL path still uses the original (un-sanitized)
  // FFAI name, so completions route to the right backend either way.
  const keyCount = new Map();
  const droppedCollisions = [];

  let added = 0;
  let unchanged = 0;
  for (const { name } of providers) {
    const sanitized = sanitizeProviderName(name);
    const seen = keyCount.get(sanitized) ?? 0;
    keyCount.set(sanitized, seen + 1);
    const disambiguated = seen === 0 ? sanitized : `${sanitized}-${seen + 1}`;
    if (seen > 0) droppedCollisions.push({ from: name, to: disambiguated });

    const entry = buildEntry(name, baseUrl, disambiguated, apiKey);
    const { action } = upsertCustomProvider(doc, entry);
    if (action === "added") added++;
    else if (action === "unchanged") unchanged++;
  }

  return { added, unchanged, removed, total: providers.length, droppedCollisions };
}

export function removeAllFfaiEntries(doc) {
  return removeCustomProvidersWhere(doc, (name) => name.startsWith(FFAI_PREFIX));
}
