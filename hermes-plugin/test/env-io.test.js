import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { upsertEnvKey } from "../lib/env-io.js";

async function tempPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ffai-hermes-test-"));
  return path.join(dir, ".env");
}

test("upsert into missing file creates it with the key", async () => {
  const p = await tempPath();
  const action = await upsertEnvKey(p, "FFAI_KEY", "secret123");
  assert.equal(action, "added");
  const raw = await fs.readFile(p, "utf8");
  assert.equal(raw, "FFAI_KEY=secret123\n");
});

test("upsert with same value is unchanged", async () => {
  const p = await tempPath();
  await fs.writeFile(p, "FFAI_KEY=secret123\n");
  const action = await upsertEnvKey(p, "FFAI_KEY", "secret123");
  assert.equal(action, "unchanged");
});

test("upsert with new value updates the existing line", async () => {
  const p = await tempPath();
  await fs.writeFile(p, "OTHER=foo\nFFAI_KEY=old\nMORE=bar\n");
  const action = await upsertEnvKey(p, "FFAI_KEY", "new");
  assert.equal(action, "updated");
  const raw = await fs.readFile(p, "utf8");
  assert.equal(raw, "OTHER=foo\nFFAI_KEY=new\nMORE=bar\n");
});

test("upsert preserves comments and ordering", async () => {
  const p = await tempPath();
  const seed = [
    "# hermes keys",
    "OPENROUTER_KEY=sk-or-...",
    "",
    "# scratch",
    "FFAI_KEY=old",
    "ANTHROPIC_API_KEY=sk-ant-...",
  ].join("\n") + "\n";
  await fs.writeFile(p, seed);
  await upsertEnvKey(p, "FFAI_KEY", "new");
  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /# hermes keys/);
  assert.match(raw, /# scratch/);
  assert.match(raw, /^FFAI_KEY=new$/m);
  assert.match(raw, /OPENROUTER_KEY=sk-or-\.\.\./);
  assert.match(raw, /ANTHROPIC_API_KEY=sk-ant-\.\.\./);
});

test("invalid key names are rejected", async () => {
  const p = await tempPath();
  await assert.rejects(() => upsertEnvKey(p, "lower_case", "x"), /invalid key name/);
  await assert.rejects(() => upsertEnvKey(p, "1STARTS_WITH_DIGIT", "x"), /invalid key name/);
});

test("values containing newline or NUL are rejected", async () => {
  // Regression: a newline in the value would let the rest land on a
  // new line, effectively injecting a second KEY=value entry.
  const p = await tempPath();
  await assert.rejects(
    () => upsertEnvKey(p, "FFAI_KEY", "safe\nANTHROPIC_API_KEY=stolen"),
    /must not contain newline/,
  );
  await assert.rejects(() => upsertEnvKey(p, "FFAI_KEY", "with\rCR"), /must not contain newline/);
  await assert.rejects(() => upsertEnvKey(p, "FFAI_KEY", "with\0null"), /must not contain newline/);
});

test("non-string values are rejected", async () => {
  const p = await tempPath();
  await assert.rejects(() => upsertEnvKey(p, "FFAI_KEY", 12345), /value must be a string/);
  await assert.rejects(() => upsertEnvKey(p, "FFAI_KEY", undefined), /value must be a string/);
});
