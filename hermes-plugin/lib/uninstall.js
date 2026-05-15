/**
 * Uninstall — remove all ffai-* entries from config.yaml's custom_providers.
 *
 * Does NOT touch ~/.hermes/.env. The FFAI_KEY env var might be referenced
 * by other tools or the user might be temporarily disabling FFAI without
 * losing the key — manual cleanup if they want it gone.
 */
import { hermesConfigPath } from "./paths.js";
import { readConfigDocument, writeConfigAtomic, withConfigLock } from "./yaml-io.js";
import { removeAllFfaiEntries } from "./apply.js";

export async function uninstall({ logger } = {}) {
  const log = logger ?? console;
  const cfgPath = hermesConfigPath();

  return withConfigLock(cfgPath, async () => {
    const doc = await readConfigDocument(cfgPath);
    const removed = removeAllFfaiEntries(doc);
    if (removed === 0) {
      log.info?.(`[hermes-plugin] no ffai-* entries found in ${cfgPath} — nothing to do`);
      return { removed: 0, configPath: cfgPath };
    }
    await writeConfigAtomic(cfgPath, doc);
    log.info?.(`[hermes-plugin] removed ${removed} ffai-* entr${removed === 1 ? "y" : "ies"} from ${cfgPath}`);
    return { removed, configPath: cfgPath };
  });
}
