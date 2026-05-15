/**
 * Install — sync providers into config.yaml AND seed FFAI_KEY into
 * ~/.hermes/.env so Hermes can authenticate to the bridge.
 *
 * Re-runnable: rerunning install after rotating FFAI_KEY rewrites the env
 * value. The user's other ~/.hermes/.env entries are preserved.
 *
 * If FFAI_KEY isn't supplied (no arg, no env var), we skip the .env write
 * rather than writing an empty value — the bridge enforces auth when
 * FFAI_KEY is set on the server, so a blank client-side value would just
 * produce 401s with no useful diagnostic.
 */
import { syncProviders } from "./sync.js";
import { upsertEnvKey } from "./env-io.js";
import { hermesEnvPath } from "./paths.js";

export async function install({ baseUrl, apiKey, timeoutMs, logger } = {}) {
  const log = logger ?? console;
  const resolvedKey = apiKey ?? process.env.FFAI_KEY?.trim() ?? "";

  const syncResult = await syncProviders({
    baseUrl,
    apiKey: resolvedKey || undefined,
    timeoutMs,
    logger,
  });
  if (!syncResult.ok) return syncResult;

  if (!resolvedKey) {
    log.warn?.(
      `[hermes-plugin] no FFAI_KEY provided — skipping ~/.hermes/.env write. ` +
      `Re-run with --key <key> or set FFAI_KEY before invoking.`,
    );
    return { ...syncResult, envWritten: false };
  }

  const envPath = hermesEnvPath();
  const envAction = await upsertEnvKey(envPath, "FFAI_KEY", resolvedKey);
  log.info?.(`[hermes-plugin] ${envPath}: FFAI_KEY ${envAction}`);
  return { ...syncResult, envWritten: true, envAction };
}
