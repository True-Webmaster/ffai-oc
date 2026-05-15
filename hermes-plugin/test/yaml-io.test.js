import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readConfigDocument,
  writeConfigAtomic,
  upsertCustomProvider,
  removeCustomProvidersWhere,
  ensureCustomProvidersSeq,
} from "../lib/yaml-io.js";

async function tempPath(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ffai-hermes-test-"));
  return path.join(dir, name);
}

test("upsert into empty file creates custom_providers seq", async () => {
  const p = await tempPath("config.yaml");
  const doc = await readConfigDocument(p);
  const r = upsertCustomProvider(doc, {
    name: "ffai-gemini",
    base_url: "http://127.0.0.1:8010/gemini/v1",
    key_env: "FFAI_KEY",
    api_mode: "chat_completions",
  });
  assert.equal(r.action, "added");
  await writeConfigAtomic(p, doc);
  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /custom_providers:/);
  assert.match(raw, /name: ffai-gemini/);
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/gemini\/v1/);
});

test("re-upserting the same entry reports unchanged", async () => {
  const p = await tempPath("config.yaml");
  const entry = {
    name: "ffai-groq",
    base_url: "http://127.0.0.1:8010/groq/v1",
    key_env: "FFAI_KEY",
    api_mode: "chat_completions",
  };
  const doc = await readConfigDocument(p);
  upsertCustomProvider(doc, entry);
  await writeConfigAtomic(p, doc);

  const doc2 = await readConfigDocument(p);
  const r = upsertCustomProvider(doc2, entry);
  assert.equal(r.action, "unchanged");
});

test("upsert preserves user comments and other top-level keys", async () => {
  const p = await tempPath("config.yaml");
  const seed = [
    "# my hermes config",
    "model:",
    "  provider: openrouter",
    "  model: anthropic/claude-opus-4   # keep this!",
    "",
    "custom_providers:",
    "  - name: my-local",
    "    base_url: http://localhost:1234/v1",
  ].join("\n");
  await fs.writeFile(p, seed, "utf8");

  const doc = await readConfigDocument(p);
  upsertCustomProvider(doc, {
    name: "ffai-gemini",
    base_url: "http://127.0.0.1:8010/gemini/v1",
    key_env: "FFAI_KEY",
    api_mode: "chat_completions",
  });
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /# my hermes config/);
  assert.match(raw, /# keep this!/);
  assert.match(raw, /name: my-local/);
  assert.match(raw, /name: ffai-gemini/);
});

test("removeCustomProvidersWhere removes only matching entries", async () => {
  const p = await tempPath("config.yaml");
  const seed = [
    "custom_providers:",
    "  - name: my-local",
    "    base_url: http://localhost:1234/v1",
    "  - name: ffai-gemini",
    "    base_url: http://127.0.0.1:8010/gemini/v1",
    "  - name: ffai-groq",
    "    base_url: http://127.0.0.1:8010/groq/v1",
  ].join("\n");
  await fs.writeFile(p, seed, "utf8");

  const doc = await readConfigDocument(p);
  const removed = removeCustomProvidersWhere(doc, (name) => name.startsWith("ffai-"));
  assert.equal(removed, 2);
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: my-local/);
  assert.doesNotMatch(raw, /name: ffai-/);
});

test("ensureCustomProvidersSeq is idempotent", async () => {
  const p = await tempPath("config.yaml");
  const doc = await readConfigDocument(p);
  ensureCustomProvidersSeq(doc);
  ensureCustomProvidersSeq(doc);
  await writeConfigAtomic(p, doc);
  const raw = await fs.readFile(p, "utf8");
  // Should appear exactly once
  assert.equal((raw.match(/custom_providers:/g) ?? []).length, 1);
});
