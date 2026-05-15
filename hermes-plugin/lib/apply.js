/**
 * Shared upsert logic — turn an FFAI provider list into Hermes
 * custom_providers entries and merge into the YAML doc.
 *
 * Each entry takes the shape Hermes documents in its custom_providers
 * section:
 *   - name        ffai-<sanitized-provider-name>
 *   - base_url    <baseUrl>/<originalProviderName>/v1
 *   - key_env     FFAI_KEY
 *   - api_mode    chat_completions
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

function buildEntry(providerName, baseUrl, disambiguatedName) {
  const nameSuffix = disambiguatedName ?? sanitizeProviderName(providerName);
  return {
    name: `${FFAI_PREFIX}${nameSuffix}`,
    base_url: `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(providerName)}/v1`,
    key_env: KEY_ENV,
    api_mode: API_MODE,
  };
}

/**
 * Replace the full `ffai-*` set in `doc.custom_providers` with entries derived
 * from `providers`. Non-`ffai-*` entries are preserved untouched. Returns a
 * summary of what changed.
 */
export function applyCustomProviders(doc, providers, baseUrl) {
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

    const entry = buildEntry(name, baseUrl, disambiguated);
    const { action } = upsertCustomProvider(doc, entry);
    if (action === "added") added++;
    else if (action === "unchanged") unchanged++;
  }

  return { added, unchanged, removed, total: providers.length, droppedCollisions };
}

export function removeAllFfaiEntries(doc) {
  return removeCustomProvidersWhere(doc, (name) => name.startsWith(FFAI_PREFIX));
}
