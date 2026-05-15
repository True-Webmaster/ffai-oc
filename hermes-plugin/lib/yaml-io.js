/**
 * config.yaml round-tripper with comment preservation, atomic write, and
 * cross-process locking.
 *
 * Design mirrors openclaw-plugin/catalog-sync.ts: random tmp suffix, fsync
 * before rename, mkdir-based lock with stale-detection.
 *
 * ## Known limitation: one-time cosmetic reformat
 *
 * The `yaml` package's Document API preserves comments and structural
 * ordering, but normalizes string serialization on emit — escaped unicode
 * (･) is rewritten to raw UTF-8 (･), multi-line quoted strings are
 * reflowed, and certain indentation choices change. This means the FIRST
 * install/sync against a hand-authored config.yaml produces a one-shot
 * cosmetic diff outside the custom_providers: block. After that, the file
 * is in the library's preferred form and subsequent syncs are byte-stable.
 *
 * Data is never lost — the diff is purely serialization choices. Hermes
 * parses both forms identically. A future v0.2 may switch to a surgical
 * text-edit approach (splice the custom_providers: block in raw text,
 * leave the rest byte-identical) if the cosmetic noise is a real problem
 * for users who track config.yaml in git.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Document, parseDocument, isSeq, isMap, YAMLSeq, YAMLMap } from "yaml";

const LOCK_STALE_MS = 60_000;
const LOCK_MAX_ATTEMPTS = 30;
const LOCK_RETRY_MS = 100;

function emptyBlockDocument() {
  const doc = new Document();
  doc.contents = new YAMLMap();
  return doc;
}

export async function readConfigDocument(configPath) {
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return emptyBlockDocument();
    throw err;
  }
  if (raw.trim() === "") return emptyBlockDocument();
  return parseDocument(raw);
}

export async function writeConfigAtomic(configPath, doc) {
  const dir = path.dirname(configPath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${configPath}.tmp-${crypto.randomUUID()}`;
  let written = false;
  try {
    const handle = await fs.open(tmp, "w", 0o600);
    try {
      const text = doc.toString();
      await handle.writeFile(text.endsWith("\n") ? text : `${text}\n`, "utf8");
      try { await handle.sync(); } catch { /* fsync best-effort */ }
    } finally {
      await handle.close();
    }
    written = true;
    await fs.rename(tmp, configPath);
  } finally {
    if (written) {
      await fs.stat(tmp).then(() => fs.unlink(tmp)).catch(() => {});
    } else {
      await fs.unlink(tmp).catch(() => {});
    }
  }
}

export async function withConfigLock(configPath, body) {
  const lockDir = `${configPath}.lock`;
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.mkdir(lockDir);
      try {
        return await body();
      } finally {
        await fs.rmdir(lockDir).catch(() => {});
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = await fs.stat(lockDir);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch { /* lock vanished — retry */ }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  throw new Error(`could not acquire ${lockDir} after ${LOCK_MAX_ATTEMPTS} attempts`);
}

/**
 * Returns the `custom_providers` YAMLSeq, creating one if absent. The seq
 * is set as a YAMLSeq Node (not a plain JS array) so subsequent
 * `doc.get(key, true)` returns the Node, not a JS value — that distinction
 * matters for in-place mutation.
 */
export function ensureCustomProvidersSeq(doc) {
  if (!doc.contents || !isMap(doc.contents)) {
    doc.contents = new YAMLMap();
  }
  let seq = doc.get("custom_providers", true);
  if (!isSeq(seq)) {
    seq = new YAMLSeq();
    doc.set("custom_providers", seq);
  }
  return seq;
}

/**
 * Upsert a custom_providers entry by name. Replaces the existing entry
 * (preserving its position in the sequence) or appends a new one. Returns
 * `{ action: "added" | "updated" | "unchanged" }`.
 */
export function upsertCustomProvider(doc, entry) {
  if (!entry?.name) throw new Error("upsertCustomProvider: entry.name is required");
  const seq = ensureCustomProvidersSeq(doc);

  for (let i = 0; i < seq.items.length; i++) {
    const item = seq.items[i];
    if (!isMap(item)) continue;
    const itemName = item.get("name");
    if (itemName !== entry.name) continue;

    const before = JSON.stringify(item.toJSON());
    const after = JSON.stringify(entry);
    if (before === after) return { action: "unchanged" };

    seq.set(i, entry);
    return { action: "updated" };
  }

  seq.add(entry);
  return { action: "added" };
}

/**
 * Remove every custom_providers entry whose `name` matches the predicate.
 * Returns the count of removed entries.
 *
 * Iterates from the end so indices stay valid as items are deleted.
 */
export function removeCustomProvidersWhere(doc, predicate) {
  const seq = doc.get("custom_providers", true);
  if (!seq || !isSeq(seq)) return 0;
  let removed = 0;
  for (let i = seq.items.length - 1; i >= 0; i--) {
    const item = seq.items[i];
    if (!isMap(item)) continue;
    const name = item.get("name");
    if (typeof name !== "string") continue;
    if (predicate(name)) {
      seq.delete(i);
      removed++;
    }
  }
  return removed;
}
