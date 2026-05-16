/**
 * Sync FFAI providers into ~/.hermes/config.yaml's custom_providers.
 *
 * Idempotent. Re-runnable. Refuses to write when discovery returns no
 * providers (wipe protection — a transient FFAI restart must not erase
 * Hermes's view of the catalog mid-session).
 */
import { discoverProviders } from "./discover.js";
import { hermesConfigPath } from "./paths.js";
import {
  readConfigDocument,
  writeConfigAtomic,
  withConfigLock,
} from "./yaml-io.js";
import { applyCustomProviders } from "./apply.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8010";

export async function syncProviders({ baseUrl, apiKey, timeoutMs, logger } = {}) {
  const log = logger ?? console;
  const resolvedBaseUrl = (baseUrl || process.env.FFAI_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const resolvedKey = apiKey ?? process.env.FFAI_KEY?.trim() ?? undefined;

  log.info?.(`[hermes-plugin] discovering FFAI providers at ${resolvedBaseUrl}`);
  const discovery = await discoverProviders({
    baseUrl: resolvedBaseUrl,
    apiKey: resolvedKey,
    timeoutMs,
  });

  if (discovery.source !== "fetched" || discovery.providers.length === 0) {
    log.warn?.(
      `[hermes-plugin] discovery returned no providers (source=${discovery.source}` +
      (discovery.error ? `: ${discovery.error}` : "") +
      `) — refusing to write config.yaml`,
    );
    return { ok: false, reason: discovery.source, providers: 0 };
  }

  const cfgPath = hermesConfigPath();
  return withConfigLock(cfgPath, async () => {
    const doc = await readConfigDocument(cfgPath);
    // Pass the resolved key through so `applyCustomProviders` emits
    // `api_key:` on each entry. Hermes's picker (section 4 of
    // model_switch.py) reads api_key directly and ignores key_env there,
    // so without this the `/model` picker shows "(0 models)" for every
    // ffai-* entry even when the bridge is healthy. See apply.js header.
    const summary = applyCustomProviders(doc, discovery.providers, resolvedBaseUrl, {
      apiKey: resolvedKey,
    });
    await writeConfigAtomic(cfgPath, doc);
    log.info?.(
      `[hermes-plugin] wrote ${cfgPath}: ` +
      `${summary.total} ffai-* providers (added=${summary.added}, unchanged=${summary.unchanged}, removed=${summary.removed})`,
    );
    if (summary.droppedCollisions?.length > 0) {
      for (const { from, to } of summary.droppedCollisions) {
        log.warn?.(
          `[hermes-plugin] provider name collision: "${from}" sanitized to ` +
          `the same key as an earlier provider — registered as "${to}" instead`,
        );
      }
    }
    return { ok: true, providers: summary.total, summary, configPath: cfgPath };
  });
}
