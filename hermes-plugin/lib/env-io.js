/**
 * ~/.hermes/.env upsert — set or update a single key without touching the
 * rest of the file. Preserves comments and ordering.
 *
 * Format: KEY=value, one per line. Lines starting with `#` are comments.
 * Empty values (`KEY=`) and quoted values (`KEY="value"`) both round-trip
 * to KEY=value on write — Hermes's loader accepts either.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function upsertEnvKey(envPath, key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`upsertEnvKey: invalid key name ${key}`);
  }

  let lines = [];
  try {
    const raw = await fs.readFile(envPath, "utf8");
    lines = raw.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  let found = false;
  let action = "added";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const lhs = line.slice(0, eq).trim();
    if (lhs !== key) continue;
    found = true;
    const current = line.slice(eq + 1);
    const next = `${key}=${value}`;
    if (current === value || `${current}` === `${value}`) {
      action = "unchanged";
    } else {
      lines[i] = next;
      action = "updated";
    }
    break;
  }

  if (!found) lines.push(`${key}=${value}`);
  if (action === "unchanged") return action;

  await writeFileAtomic(envPath, `${lines.join("\n")}\n`, 0o600);
  return action;
}

async function writeFileAtomic(filePath, content, mode) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomUUID()}`;
  let written = false;
  try {
    const handle = await fs.open(tmp, "w", mode);
    try {
      await handle.writeFile(content, "utf8");
      try { await handle.sync(); } catch { /* fsync best-effort */ }
    } finally {
      await handle.close();
    }
    written = true;
    await fs.rename(tmp, filePath);
  } finally {
    if (written) {
      await fs.stat(tmp).then(() => fs.unlink(tmp)).catch(() => {});
    } else {
      await fs.unlink(tmp).catch(() => {});
    }
  }
}
