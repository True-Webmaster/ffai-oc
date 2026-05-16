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
  // No api_key when apiKey isn't passed.
  assert.doesNotMatch(raw, /api_key:/);
});

test("applyCustomProviders emits api_key on every entry when apiKey is provided", async () => {
  // Regression: Hermes's picker section 4 reads entry['api_key'] directly
  // and ignores key_env, so without api_key every ffai-* entry shows
  // "(0 models)" even when the bridge is healthy. apply.js must therefore
  // emit api_key alongside key_env when a key value is available.
  const p = await tempPath();
  const doc = await readConfigDocument(p);
  applyCustomProviders(
    doc,
    [{ name: "gemini" }, { name: "groq" }],
    "http://127.0.0.1:8010",
    { apiKey: "ffai-test-key-abc123" },
  );
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /api_key: ffai-test-key-abc123/);
  // Both fields present on each entry.
  const apiKeyHits = (raw.match(/api_key: ffai-test-key-abc123/g) ?? []).length;
  const keyEnvHits = (raw.match(/key_env: FFAI_KEY/g) ?? []).length;
  assert.equal(apiKeyHits, 2);
  assert.equal(keyEnvHits, 2);
});

test("applyCustomProviders ignores empty/whitespace apiKey", async () => {
  // A blank apiKey from a misconfigured env shouldn't become `api_key: ""`
  // in the file — that would be worse than omitting it (Hermes might try
  // to send `Authorization: Bearer ` and get a confusing 401).
  const p = await tempPath();
  const doc = await readConfigDocument(p);
  applyCustomProviders(
    doc,
    [{ name: "gemini" }],
    "http://127.0.0.1:8010",
    { apiKey: "   " },
  );
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.doesNotMatch(raw, /api_key:/);
  assert.match(raw, /key_env: FFAI_KEY/);
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

test("collision in sanitized provider names produces a disambiguated entry, not a clobber", async () => {
  // Regression: two FFAI providers that sanitize to the same custom
  // _providers `name` (e.g. "Groq!" and "groq?") used to silently
  // clobber each other on upsert. Now the second collision becomes
  // ffai-groq-2 with its own base_url path.
  const p = await tempPath();
  const doc = await readConfigDocument(p);
  const summary = applyCustomProviders(
    doc,
    [{ name: "Groq!" }, { name: "groq?" }],
    "http://127.0.0.1:8010",
  );
  await writeConfigAtomic(p, doc);

  const raw = await fs.readFile(p, "utf8");
  assert.match(raw, /name: ffai-groq$/m);
  assert.match(raw, /name: ffai-groq-2/);
  // `!` is unreserved in RFC 3986 so encodeURIComponent leaves it raw; `?`
  // is reserved and gets %3F. Either way each provider gets its own URL.
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/Groq!\/v1/);
  assert.match(raw, /base_url: http:\/\/127\.0\.0\.1:8010\/groq%3F\/v1/);
  assert.equal(summary.droppedCollisions.length, 1);
  assert.deepEqual(summary.droppedCollisions[0], { from: "groq?", to: "groq-2" });
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
