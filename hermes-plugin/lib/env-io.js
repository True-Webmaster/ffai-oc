/**
 * ~/.hermes/.env upsert — set or update a single key without touching the
 * rest of the file. Preserves comments and ordering.
 *
 * Format: KEY=value, one per line. Lines starting with `#` are comments.
 * Empty values (`KEY=`) and quoted values (`KEY="value"`) both round-trip
 * to KEY=value on write — Hermes's loader accepts either.
 *
 * Security:
 *   - Key name validated against `^[A-Z_][A-Z0-9_]*$`.
 *   - Value rejected if it contains \n, \r, or NUL — without this, a key
 *     value containing a newline lets an attacker inject a second env
 *     line (`FFAI_KEY=safe\nANTHROPIC_API_KEY=stolen`).
 *   - Cross-process lock around read-modify-write so concurrent
 *     `ffai-hermes install` invocations or editor saves can't interleave.
 *   - Atomic write (random tmp + fsync + rename) shared with yaml-io.
 */
import { promises as fs } from "node:fs";
import { writeFileAtomic, withConfigLock } from "./yaml-io.js";

export async function upsertEnvKey(envPath, key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
    throw new Error(`upsertEnvKey: invalid key name ${key}`);
  }
  if (typeof value !== "string") {
    throw new Error(`upsertEnvKey: value must be a string`);
  }
  if (/[\r\n\0]/.test(value)) {
    // A newline in the value would let the rest of the value land on a
    // new line of the .env file, effectively writing a second KEY=value
    // entry under attacker control. Refuse rather than try to escape —
    // .env has no universal escape syntax across loaders.
    throw new Error(`upsertEnvKey: value must not contain newline or NUL`);
  }

  return withConfigLock(envPath, async () => {
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
      if (current === value) {
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
  });
}
