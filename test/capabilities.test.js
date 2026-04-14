/**
 * Tests for Feature 5: Provider Capability Auto-Detection.
 *
 * Covers:
 * - ingestFromDiscovery stores model capabilities
 * - ingestFromHeaders stores learned limits
 * - ingestFromResponse marks streaming support
 * - getModel returns correct data
 * - getAll serializes properly (Sets become arrays)
 * - getByProvider filters correctly
 * - Multiple ingestions merge (don't overwrite existing with null)
 * - Unknown model returns null from getModel
 * - Capabilities exposed in /providers response format
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const CapabilityStore = require("../lib/capabilities");

const silent = { log() {}, warn() {}, error() {} };

function makeStore() {
  return new CapabilityStore({ logger: silent });
}

// ── ingestFromDiscovery ───────────────────────────────────────────────────────

describe("ingestFromDiscovery", () => {
  it("stores model capabilities", () => {
    const store = makeStore();
    store.ingestFromDiscovery("gemini-2.5-flash", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      inputTypes: ["text", "image"],
    });

    const model = store.getModel("gemini-2.5-flash");
    assert.ok(model);
    assert.equal(model.provider, "gemini");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxOutputTokens, 65536);
    assert.deepEqual(model.inputTypes, ["text", "image"]);
  });

  it("does not overwrite existing non-zero values with zero/null", () => {
    const store = makeStore();
    store.ingestFromDiscovery("model-a", "prov", {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputTypes: ["text"],
    });

    // Second ingestion with partial data
    store.ingestFromDiscovery("model-a", "prov", {
      contextWindow: 0,
      maxOutputTokens: null,
      inputTypes: [],
    });

    const model = store.getModel("model-a");
    assert.equal(model.contextWindow, 128000, "contextWindow should not be overwritten with 0");
    assert.equal(model.maxOutputTokens, 4096, "maxOutputTokens should not be overwritten with null");
    assert.deepEqual(model.inputTypes, ["text"], "inputTypes should not be cleared");
  });

  it("merges inputTypes across ingestions", () => {
    const store = makeStore();
    store.ingestFromDiscovery("model-b", "prov", {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputTypes: ["text"],
    });

    store.ingestFromDiscovery("model-b", "prov", {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputTypes: ["image"],
    });

    const model = store.getModel("model-b");
    assert.deepEqual(model.inputTypes.sort(), ["image", "text"]);
  });
});

// ── ingestFromHeaders ─────────────────────────────────────────────────────────

describe("ingestFromHeaders", () => {
  it("stores learned rate limits", () => {
    const store = makeStore();
    store.ingestFromHeaders("model-a", "groq", { rpm: 30, tpm: 50000, rpd: 1000 });

    const model = store.getModel("model-a");
    assert.ok(model);
    assert.deepEqual(model.learnedLimits, { rpm: 30, tpm: 50000, rpd: 1000 });
  });

  it("only updates non-null fields", () => {
    const store = makeStore();
    store.ingestFromHeaders("model-a", "groq", { rpm: 30, tpm: 50000, rpd: 1000 });
    store.ingestFromHeaders("model-a", "groq", { rpm: 15 });

    const model = store.getModel("model-a");
    assert.equal(model.learnedLimits.rpm, 15);
    assert.equal(model.learnedLimits.tpm, 50000, "tpm should not be cleared");
    assert.equal(model.learnedLimits.rpd, 1000, "rpd should not be cleared");
  });
});

// ── ingestFromResponse ────────────────────────────────────────────────────────

describe("ingestFromResponse", () => {
  it("marks streaming support on first observation", () => {
    const store = makeStore();
    store.ingestFromResponse("model-a", "gemini", { streaming: true });

    const model = store.getModel("model-a");
    assert.equal(model.supportsStreaming, true);
  });

  it("does not flip streaming once set", () => {
    const store = makeStore();
    store.ingestFromResponse("model-a", "gemini", { streaming: true });
    store.ingestFromResponse("model-a", "gemini", { streaming: false });

    const model = store.getModel("model-a");
    assert.equal(model.supportsStreaming, true, "should not flip after first observation");
  });

  it("marks non-streaming on first observation", () => {
    const store = makeStore();
    store.ingestFromResponse("model-a", "groq", { streaming: false });

    const model = store.getModel("model-a");
    assert.equal(model.supportsStreaming, false);
  });
});

// ── getModel ──────────────────────────────────────────────────────────────────

describe("getModel", () => {
  it("returns correct data for known model", () => {
    const store = makeStore();
    store.ingestFromDiscovery("llama-4-scout", "groq", {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      inputTypes: ["text", "image"],
    });
    store.ingestFromResponse("llama-4-scout", "groq", { streaming: true });
    store.ingestFromHeaders("llama-4-scout", "groq", { rpm: 30 });

    const model = store.getModel("llama-4-scout");
    assert.equal(model.provider, "groq");
    assert.equal(model.contextWindow, 131072);
    assert.equal(model.maxOutputTokens, 8192);
    assert.deepEqual(model.inputTypes, ["text", "image"]);
    assert.equal(model.supportsStreaming, true);
    assert.equal(model.learnedLimits.rpm, 30);
    assert.ok(model.updatedAt > 0);
  });

  it("returns null for unknown model", () => {
    const store = makeStore();
    assert.equal(store.getModel("nonexistent"), null);
  });

  it("returns a copy, not internal reference", () => {
    const store = makeStore();
    store.ingestFromDiscovery("model-a", "prov", {
      contextWindow: 128000,
      maxOutputTokens: 4096,
      inputTypes: ["text"],
    });

    const model1 = store.getModel("model-a");
    model1.inputTypes.push("image");
    model1.learnedLimits.rpm = 999;

    const model2 = store.getModel("model-a");
    assert.deepEqual(model2.inputTypes, ["text"], "inputTypes should not be mutated externally");
    assert.equal(model2.learnedLimits.rpm, undefined, "learnedLimits should not be mutated externally");
  });
});

// ── getAll ─────────────────────────────────────────────────────────────────────

describe("getAll", () => {
  it("serializes properly (Sets become arrays)", () => {
    const store = makeStore();
    store.ingestFromDiscovery("model-a", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      inputTypes: ["text", "image"],
    });
    store.ingestFromDiscovery("model-b", "groq", {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      inputTypes: ["text"],
    });

    const all = store.getAll();

    // Should be a plain object, not a Map
    assert.equal(typeof all, "object");
    assert.ok(!(all instanceof Map));

    // Should be JSON-serializable
    const json = JSON.stringify(all);
    const parsed = JSON.parse(json);

    assert.ok(parsed["model-a"]);
    assert.ok(parsed["model-b"]);
    assert.ok(Array.isArray(parsed["model-a"].inputTypes));
    assert.deepEqual(parsed["model-a"].inputTypes, ["text", "image"]);
    assert.deepEqual(parsed["model-b"].inputTypes, ["text"]);
  });

  it("returns empty object when no models ingested", () => {
    const store = makeStore();
    const all = store.getAll();
    assert.deepEqual(all, {});
  });
});

// ── getByProvider ─────────────────────────────────────────────────────────────

describe("getByProvider", () => {
  it("filters correctly", () => {
    const store = makeStore();
    store.ingestFromDiscovery("gemini-2.5-flash", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      inputTypes: ["text", "image"],
    });
    store.ingestFromDiscovery("gemini-2.0-flash", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 8192,
      inputTypes: ["text", "image"],
    });
    store.ingestFromDiscovery("llama-4-scout", "groq", {
      contextWindow: 131072,
      maxOutputTokens: 8192,
      inputTypes: ["text"],
    });

    const geminiModels = store.getByProvider("gemini");
    assert.equal(Object.keys(geminiModels).length, 2);
    assert.ok(geminiModels["gemini-2.5-flash"]);
    assert.ok(geminiModels["gemini-2.0-flash"]);
    assert.ok(!geminiModels["llama-4-scout"]);

    const groqModels = store.getByProvider("groq");
    assert.equal(Object.keys(groqModels).length, 1);
    assert.ok(groqModels["llama-4-scout"]);
  });

  it("returns empty object for unknown provider", () => {
    const store = makeStore();
    const result = store.getByProvider("nonexistent");
    assert.deepEqual(result, {});
  });
});

// ── Multiple ingestions merge ─────────────────────────────────────────────────

describe("multiple ingestions merge", () => {
  it("combines discovery, headers, and response data", () => {
    const store = makeStore();

    // Discovery first
    store.ingestFromDiscovery("model-a", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      inputTypes: ["text"],
    });

    // Headers add limits
    store.ingestFromHeaders("model-a", "gemini", { rpm: 60, tpm: 100000 });

    // Response adds streaming
    store.ingestFromResponse("model-a", "gemini", { streaming: true });

    // Second discovery adds image support
    store.ingestFromDiscovery("model-a", "gemini", {
      inputTypes: ["image"],
    });

    const model = store.getModel("model-a");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.maxOutputTokens, 65536);
    assert.deepEqual(model.inputTypes.sort(), ["image", "text"]);
    assert.equal(model.supportsStreaming, true);
    assert.equal(model.learnedLimits.rpm, 60);
    assert.equal(model.learnedLimits.tpm, 100000);
  });
});

// ── Capabilities in /providers format ─────────────────────────────────────────

describe("capabilities in /providers response format", () => {
  it("getByProvider output matches expected shape for /providers endpoint", () => {
    const store = makeStore();
    store.ingestFromDiscovery("gemini-2.5-flash", "gemini", {
      contextWindow: 1048576,
      maxOutputTokens: 65536,
      inputTypes: ["text", "image"],
    });
    store.ingestFromHeaders("gemini-2.5-flash", "gemini", { rpm: 10 });
    store.ingestFromResponse("gemini-2.5-flash", "gemini", { streaming: true });

    const providerCaps = store.getByProvider("gemini");

    // Simulate what /providers would return
    const providerResult = {
      gemini: {
        keys: 3,
        scoring: "enabled",
        capabilities: providerCaps,
      },
    };

    // Should be JSON-serializable
    const json = JSON.stringify(providerResult);
    const parsed = JSON.parse(json);

    const cap = parsed.gemini.capabilities["gemini-2.5-flash"];
    assert.ok(cap);
    assert.equal(cap.contextWindow, 1048576);
    assert.equal(cap.maxOutputTokens, 65536);
    assert.deepEqual(cap.inputTypes, ["text", "image"]);
    assert.equal(cap.supportsStreaming, true);
    assert.equal(cap.learnedLimits.rpm, 10);
  });
});
