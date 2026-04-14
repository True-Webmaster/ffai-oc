/**
 * Model-aware rotation intelligence tests.
 *
 * Tests per-model rate tracking, input-token-aware routing,
 * rate-limit header ingestion, and non-SSE usage extraction.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Provider = require("../lib/provider");
const Pool = require("../lib/pool");
const KeyScorer = require("../lib/key-scorer");
const path = require("node:path");
const os = require("node:os");

function tmpStats() {
  return path.join(os.tmpdir(), `ffai-model-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const silent = { log() {}, warn() {}, error() {} };

describe("Model-aware KeyScorer", () => {
  function makeScorer(overrides = {}) {
    return new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 15,
      tpmLimit: 1000000,
      rpdLimit: 1500,
      logger: silent,
      modelLimits: {
        "slow-model": { rpm: 5, tpm: 250000, rpd: 500 },
        "fast-model": { rpm: 15, tpm: 1000000, rpd: 1500 },
      },
      ...overrides,
    });
  }

  it("selectKey accepts model and inputTokens", () => {
    const s = makeScorer();
    const key = s.selectKey("fast-model", 100);
    assert.ok(key, "should return a key");
    assert.ok(["k1", "k2"].includes(key));
  });

  it("selectKey still works without model (backward compat)", () => {
    const s = makeScorer();
    const key = s.selectKey();
    assert.ok(key, "should return a key without model");
  });

  it("recordRequest tracks per-model window", () => {
    const s = makeScorer();
    s.recordRequest("k1", 500, "slow-model");
    s.recordRequest("k1", 300, "fast-model");
    s.recordRequest("k1", 200); // no model

    // Aggregate should have all
    const agg = s.windows.get("k1").totals();
    assert.equal(agg.requests, 3);
    assert.equal(agg.tokens, 1000);

    // Per-model should be separate
    const slowW = s.modelWindows.get("k1").get("slow-model");
    assert.ok(slowW, "should have slow-model window");
    const slowT = slowW.totals();
    assert.equal(slowT.requests, 1);
    assert.equal(slowT.tokens, 500);

    const fastW = s.modelWindows.get("k1").get("fast-model");
    const fastT = fastW.totals();
    assert.equal(fastT.requests, 1);
    assert.equal(fastT.tokens, 300);
  });

  it("recordResponse tracks per-model output tokens", () => {
    const s = makeScorer();
    s.recordResponse("k1", 200, "slow-model");

    const mw = s.modelWindows.get("k1").get("slow-model");
    assert.ok(mw);
    const t = mw.totals();
    assert.equal(t.tokens, 200);
    assert.equal(t.requests, 0); // response doesn't add requests
  });

  it("prefers key with more model-specific headroom", () => {
    const s = makeScorer();

    // Load k1 heavily for slow-model (4 of 5 RPM used)
    for (let i = 0; i < 4; i++) s.recordRequest("k1", 100, "slow-model");
    // k2 is idle

    // When routing slow-model, should prefer k2 (more headroom)
    const key = s.selectKey("slow-model", 100);
    assert.equal(key, "k2", "should prefer key with more model-specific headroom");
  });

  it("penalizes key when inputTokens would exceed TPM", () => {
    const s = makeScorer({
      rpmLimit: 100,
      tpmLimit: 1000, // low TPM for testing
      modelLimits: {},
    });

    // Load k1 to 960 tokens (96% of 1000 TPM)
    s.recordRequest("k1", 960);
    // k2 is idle

    // A 100-token request should avoid k1 (960+100 > 950 = 95% of 1000)
    const key = s.selectKey(null, 100);
    assert.equal(key, "k2", "should avoid key where inputTokens would exceed TPM threshold");
  });

  it("uses provider defaults when model has no specific limits", () => {
    const s = makeScorer();
    const limits = s._getModelLimits("unknown-model");
    assert.equal(limits.rpm, 15, "should fall back to provider rpmLimit");
    assert.equal(limits.tpm, 1000000, "should fall back to provider tpmLimit");
  });

  it("uses model-specific limits when configured", () => {
    const s = makeScorer();
    const limits = s._getModelLimits("slow-model");
    assert.equal(limits.rpm, 5);
    assert.equal(limits.tpm, 250000);
    assert.equal(limits.rpd, 500);
  });

  it("model windows are lazily created", () => {
    const s = makeScorer();
    // Before any model-specific request, the model map should be empty
    assert.equal(s.modelWindows.get("k1").size, 0);

    s.recordRequest("k1", 100, "slow-model");
    assert.equal(s.modelWindows.get("k1").size, 1);

    s.recordRequest("k1", 100, "fast-model");
    assert.equal(s.modelWindows.get("k1").size, 2);
  });
});

describe("Rate-limit header ingestion", () => {
  function makeScorer() {
    return new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 30,
      logger: silent,
    });
  }

  it("learns lower RPM from x-ratelimit-limit-requests header", () => {
    const s = makeScorer();
    assert.equal(s.learnedRpm.get("k1"), undefined);

    s.ingestRateLimitHeaders("k1", { "x-ratelimit-limit-requests": "15" });
    assert.equal(s.learnedRpm.get("k1"), 15);
  });

  it("does not increase learned RPM from headers", () => {
    const s = makeScorer();
    s.learnedRpm.set("k1", 10);

    s.ingestRateLimitHeaders("k1", { "x-ratelimit-limit-requests": "30" });
    assert.equal(s.learnedRpm.get("k1"), 10, "should not increase learned limit");
  });

  it("ignores invalid header values", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", { "x-ratelimit-limit-requests": "not-a-number" });
    assert.equal(s.learnedRpm.get("k1"), undefined);
  });

  it("handles null/missing headers", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", null);
    s.ingestRateLimitHeaders("k1", {});
    assert.equal(s.learnedRpm.get("k1"), undefined);
  });
});

describe("Model-aware Provider", () => {
  it("passes model_limits to scorer", () => {
    const prov = new Provider("testprov", {
      keys: ["k1", "k2"],
      rpm_limit: 15,
      tpm_limit: 1000000,
      rpd_limit: 1500,
      model_limits: {
        "slow-model": { rpm: 5, tpm: 250000 },
      },
      logger: silent,
    });

    assert.ok(prov.scorer);
    assert.ok(prov.scorer.modelLimits["slow-model"]);
    assert.equal(prov.scorer.modelLimits["slow-model"].rpm, 5);
  });

  it("acquire accepts model and inputTokens", () => {
    const prov = new Provider("testprov", {
      keys: ["k1", "k2"],
      rpm_limit: 15,
      logger: silent,
    });

    const key = prov.acquire("some-model", 500);
    assert.ok(key);
  });

  it("release passes model to scorer", () => {
    const prov = new Provider("testprov", {
      keys: ["k1"],
      rpm_limit: 15,
      logger: silent,
    });

    const key = prov.acquire();
    prov.release(key, { success: true, model: "test-model", inputTokens: 100, outputTokens: 50 });

    // Check that model window was created
    const mw = prov.scorer.modelWindows.get(key).get("test-model");
    assert.ok(mw, "should have created model window via release");
  });

  it("release ingests rate limit headers", () => {
    const prov = new Provider("testprov", {
      keys: ["k1"],
      rpm_limit: 30,
      logger: silent,
    });

    const key = prov.acquire();
    prov.release(key, {
      success: true,
      rateLimitHeaders: { "x-ratelimit-limit-requests": "10" },
    });

    assert.equal(prov.scorer.learnedRpm.get(key), 10);
  });
});

describe("Model-aware Pool", () => {
  it("acquire passes model and inputTokens to provider", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1", "k2"], rpm_limit: 15, logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const handle = pool.acquire("prov1", { model: "test-model", inputTokens: 500 });
    assert.ok(handle);
    assert.equal(handle.provider, "prov1");
    pool.shutdown();
  });

  it("acquire still works without opts (backward compat)", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1"], rpm_limit: 15, logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const handle = pool.acquire("prov1");
    assert.ok(handle);
    pool.shutdown();
  });

  it("acquireFromFamily passes opts through", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1"], rpm_limit: 15, family: "fam1", logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const handle = pool.acquireFromFamily("fam1", { model: "test-model", inputTokens: 100 });
    assert.ok(handle);
    assert.equal(handle.family, "fam1");
    pool.shutdown();
  });

  it("release with model tracks per-model usage", () => {
    const pool = new Pool({
      providers: {
        prov1: {
          keys: ["k1"],
          rpm_limit: 15,
          model_limits: { "slow": { rpm: 5 } },
          logger: silent,
        },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const handle = pool.acquire("prov1", { model: "slow" });
    pool.release("prov1", handle.key, {
      success: true,
      model: "slow",
      inputTokens: 100,
      outputTokens: 50,
    });

    const prov = pool.getProvider("prov1");
    const mw = prov.scorer.modelWindows.get(handle.key).get("slow");
    assert.ok(mw, "should track per-model usage through pool.release");
    pool.shutdown();
  });
});

describe("keyStatuses includes model info", () => {
  it("shows active model windows in status", () => {
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 15,
      modelLimits: { "my-model": { rpm: 5, tpm: 100000 } },
      logger: silent,
    });

    s.recordRequest("k1", 100, "my-model");

    const statuses = s.keyStatuses();
    const k1Status = statuses["...k1"];
    assert.ok(k1Status.modelWindows, "should include modelWindows");
    assert.ok(k1Status.modelWindows["my-model"], "should have my-model stats");
    assert.equal(k1Status.modelWindows["my-model"].rpm, 1);
    assert.equal(k1Status.modelWindows["my-model"].tpm, 100);
    assert.ok(k1Status.modelWindows["my-model"].limits, "should include model limits");
  });

  it("returns null modelWindows when no model activity", () => {
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 15,
      logger: silent,
    });

    s.recordRequest("k1", 100); // no model

    const statuses = s.keyStatuses();
    assert.equal(statuses["...k1"].modelWindows, null);
  });
});
