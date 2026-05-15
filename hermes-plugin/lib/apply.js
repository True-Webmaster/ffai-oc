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

function buildEntry(providerName, baseUrl) {
  const sanitized = sanitizeProviderName(providerName);
  return {
    name: `${FFAI_PREFIX}${sanitized}`,
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

  let added = 0;
  let unchanged = 0;
  for (const { name } of providers) {
    const entry = buildEntry(name, baseUrl);
    const { action } = upsertCustomProvider(doc, entry);
    if (action === "added") added++;
    else if (action === "unchanged") unchanged++;
  }

  return { added, unchanged, removed, total: providers.length };
}

export function removeAllFfaiEntries(doc) {
  return removeCustomProvidersWhere(doc, (name) => name.startsWith(FFAI_PREFIX));
}
