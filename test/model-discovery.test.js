const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const ModelDiscovery = require("../lib/model-discovery");

// Minimal mock pool — just enough for ModelDiscovery constructor
function mockPool(providerNames = []) {
  return {
    providerNames: () => providerNames,
    getProvider: () => null,
    _upstreamUrls: {},
    discovery: null,
  };
}

// Helper: create discovery and manually populate cache for testing getters
function populatedDiscovery() {
  const pool = mockPool(["gemini", "groq"]);
  const d = new ModelDiscovery({ pool, logger: { log() {}, warn() {}, error() {} } });

  // Manually populate cache (simulating a successful refresh)
  d._cache.set("gemini", {
    models: [
      { id: "gemini-2.5-flash", object: "model", owned_by: "gemini", provider: "gemini", context_window: 1048576, max_output_tokens: 65536, input_types: ["text", "image"] },
      { id: "gemini-2.0-flash", object: "model", owned_by: "gemini", provider: "gemini", context_window: 1048576, max_output_tokens: 8192, input_types: ["text", "image"] },
    ],
    fetchedAt: Date.now(),
  });
  d._cache.set("groq", {
    models: [
      { id: "llama-4-scout-17b-16e-instruct", object: "model", owned_by: "groq", provider: "groq", context_window: 131072, max_output_tokens: 8192, input_types: ["text", "image"] },
    ],
    fetchedAt: Date.now(),
  });

  // Populate index
  for (const entry of d._cache.values()) {
    for (const m of entry.models) {
      d._modelIndex.set(m.id, {
        provider: m.provider,
        contextWindow: m.context_window,
        maxOutputTokens: m.max_output_tokens,
        inputTypes: m.input_types,
      });
    }
  }
  return d;
}

describe("ModelDiscovery._filterModels", () => {
  const pool = mockPool();
  const d = new ModelDiscovery({ pool, logger: { log() {}, warn() {}, error() {} } });

  it("filters out embed models", () => {
    const models = [{ id: "text-embedding-3-large" }];
    assert.equal(d._filterModels(models, "openai").length, 0);
  });

  it("filters out tts models", () => {
    const models = [{ id: "tts-1-hd" }];
    assert.equal(d._filterModels(models, "openai").length, 0);
  });

  it("filters out whisper models", () => {
    const models = [{ id: "whisper-large-v3" }];
    assert.equal(d._filterModels(models, "groq").length, 0);
  });

  it("filters out imagen models", () => {
    const models = [{ id: "imagen-3.0-generate-002" }];
    assert.equal(d._filterModels(models, "gemini").length, 0);
  });

  it("filters out image-keyword models", () => {
    const models = [{ id: "gemini-2.0-flash-image-generation" }];
    assert.equal(d._filterModels(models, "gemini").length, 0);
  });

  it("filters out veo models", () => {
    const models = [{ id: "veo-2.0-generate-001" }];
    assert.equal(d._filterModels(models, "gemini").length, 0);
  });

  it("filters out deep-research models", () => {
    const models = [{ id: "gemini-2.5-flash-deep-research" }];
    assert.equal(d._filterModels(models, "gemini").length, 0);
  });

  it("filters out -latest aliases", () => {
    const models = [
      { id: "gemini-2.5-flash" },
      { id: "gemini-2.5-flash-latest" },
    ];
    const result = d._filterModels(models, "gemini");
    assert.equal(result.length, 1);
    assert.equal(result[0]._cleanId, "gemini-2.5-flash");
  });

  it("filters versioned duplicates (model-001 when model exists)", () => {
    const models = [
      { id: "gemini-2.5-flash" },
      { id: "gemini-2.5-flash-001" },
    ];
    const result = d._filterModels(models, "gemini");
    assert.equal(result.length, 1);
    assert.equal(result[0]._cleanId, "gemini-2.5-flash");
  });

  it("keeps versioned model when base does not exist", () => {
    const models = [{ id: "gemini-2.5-flash-001" }];
    const result = d._filterModels(models, "gemini");
    assert.equal(result.length, 1);
  });

  it("filters small models (<4B params)", () => {
    const models = [{ id: "gemma-3-1b-it" }];
    assert.equal(d._filterModels(models, "gemini").length, 0);
  });

  it("keeps models with 4B+ params", () => {
    const models = [{ id: "gemma-3-4b-it" }];
    const result = d._filterModels(models, "gemini");
    assert.equal(result.length, 1);
  });

  it("filters models with tiny context window", () => {
    const models = [{ id: "some-model", context_window: 2048 }];
    assert.equal(d._filterModels(models, "test").length, 0);
  });

  it("filters models with context_window below 32K agent minimum", () => {
    const models = [{ id: "some-model", context_window: 8192 }];
    assert.equal(d._filterModels(models, "test").length, 0, "8K context too small for agents");
  });

  it("passes models with context_window >= 32768", () => {
    const models = [{ id: "some-model", context_window: 32768 }];
    const result = d._filterModels(models, "test");
    assert.equal(result.length, 1);
  });

  it("passes models with context_window 0 (unknown)", () => {
    const models = [{ id: "some-model", context_window: 0 }];
    const result = d._filterModels(models, "test");
    assert.equal(result.length, 1);
  });

  it("strips models/ prefix from IDs", () => {
    const models = [{ id: "models/gemini-2.5-flash" }];
    const result = d._filterModels(models, "gemini");
    assert.equal(result.length, 1);
    assert.equal(result[0]._cleanId, "gemini-2.5-flash");
  });

  it("passes regular chat models through", () => {
    const models = [
      { id: "gemini-2.5-pro" },
      { id: "gemini-2.0-flash" },
      { id: "llama-4-scout-17b-16e-instruct" },
    ];
    const result = d._filterModels(models, "test");
    assert.equal(result.length, 3);
  });

  it("handles empty upstream response gracefully", () => {
    const result = d._filterModels([], "test");
    assert.equal(result.length, 0);
  });

  it("filters orpheus models", () => {
    const models = [{ id: "orpheus-3b-v0.1-ft" }];
    assert.equal(d._filterModels(models, "groq").length, 0);
  });

  it("filters safeguard models", () => {
    const models = [{ id: "llama-safeguard-8b" }];
    assert.equal(d._filterModels(models, "groq").length, 0);
  });

  it("filters distil models", () => {
    const models = [{ id: "distil-whisper-large-v3-en" }];
    assert.equal(d._filterModels(models, "groq").length, 0);
  });

  it("filters computer-use models", () => {
    const models = [{ id: "claude-3.5-sonnet-computer-use" }];
    assert.equal(d._filterModels(models, "test").length, 0);
  });
});

describe("ModelDiscovery getters (manually populated cache)", () => {
  it("getModels returns models for a specific provider", () => {
    const d = populatedDiscovery();
    const gemini = d.getModels("gemini");
    assert.equal(gemini.length, 2);
    assert.equal(gemini[0].id, "gemini-2.5-flash");
  });

  it("getModels returns empty array for unknown provider", () => {
    const d = populatedDiscovery();
    assert.deepEqual(d.getModels("nonexistent"), []);
  });

  it("getAllModels returns merged models across all providers", () => {
    const d = populatedDiscovery();
    const all = d.getAllModels();
    assert.equal(all.length, 3);
  });

  it("getModelInfo returns correct data", () => {
    const d = populatedDiscovery();
    const info = d.getModelInfo("gemini-2.5-flash");
    assert.ok(info);
    assert.equal(info.provider, "gemini");
    assert.equal(info.contextWindow, 1048576);
    assert.equal(info.maxOutputTokens, 65536);
    assert.deepEqual(info.inputTypes, ["text", "image"]);
  });

  it("getModelInfo returns null for unknown model", () => {
    const d = populatedDiscovery();
    assert.equal(d.getModelInfo("nonexistent-model"), null);
  });
});

describe("ModelDiscovery lifecycle", () => {
  it("empty cache returns empty arrays", () => {
    const pool = mockPool();
    const d = new ModelDiscovery({ pool, logger: { log() {}, warn() {}, error() {} } });
    assert.deepEqual(d.getModels("anything"), []);
    assert.deepEqual(d.getAllModels(), []);
    assert.equal(d.getModelInfo("anything"), null);
  });
});
