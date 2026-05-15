import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readConfigDocument, writeConfigAtomic } from "../lib/yaml-io.js";
import { applyCustomProviders, removeAllFfaiEntries } from "../lib/apply.js";

async function tempPath(name = "config.yaml") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ffai-hermes-test-"));
  return path.join(dir, name);
}

test("applyCustomProviders writes one entry per provider with correct base_url", async () => {
  const p = await tempPath();
  const doc = await readConfigDocument(p);
  const summary = applyCustomProviders(
    doc,
    [{ name: "gemini" }, { name: "groq" }],
    "http://127.0.0.1:8010",
  );
  assert.equal(summary.total, 2);
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: ffai-gemini/);
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/gemini\/v1/);
  assert.match(raw, /name: ffai-groq/);
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/groq\/v1/);
  assert.match(raw, /key_env: FFAI_KEY/);
  assert.match(raw, /api_mode: chat_completions/);
});

test("applyCustomProviders preserves non-ffai entries and replaces only ffai-*", async () => {
  const p = await tempPath();
  const seed = [
    "custom_providers:",
    "  - name: my-local",
    "    base_url: http://localhost:1234/v1",
    "  - name: ffai-old-thing",
    "    base_url: http://127.0.0.1:8010/old-thing/v1",
    "    key_env: FFAI_KEY",
    "    api_mode: chat_completions",
  ].join("\n");
  await fs.writeFile(p, seed, "utf8");

  const doc = await readConfigDocument(p);
  applyCustomProviders(doc, [{ name: "gemini" }], "http://127.0.0.1:8010");
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: my-local/);
  assert.doesNotMatch(raw, /name: ffai-old-thing/);
  assert.match(raw, /name: ffai-gemini/);
});

test("applyCustomProviders URL-encodes provider names with special chars", async () => {
  const p = await tempPath();
  const doc = await readConfigDocument(p);
  applyCustomProviders(
    doc,
    [{ name: "weird/name with spaces" }],
    "http://127.0.0.1:8010",
  );
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: ffai-weird-name-with-spaces/);
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/weird%2Fname%20with%20spaces\/v1/);
});

test("removeAllFfaiEntries leaves non-ffai untouched", async () => {
  const p = await tempPath();
  const seed = [
    "custom_providers:",
    "  - name: my-local",
    "  - name: ffai-a",
    "  - name: ffai-b",
    "  - name: another",
  ].join("\n");
  await fs.writeFile(p, seed, "utf8");

  const doc = await readConfigDocument(p);
  const removed = removeAllFfaiEntries(doc);
  assert.equal(removed, 2);
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: my-local/);
  assert.match(raw, /name: another/);
  assert.doesNotMatch(raw, /name: ffai-/);
});
