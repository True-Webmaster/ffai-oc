/**
 * Tests for free-tier wall solutions:
 * - Wall 3: TPM filtering in discovery + pre-send rejection
 * - Wall 4: Context window minimum raised to 32K
 * - Wall 5: Shared-quota key detection
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const KeyScorer = require("../lib/key-scorer");

const silent = { log() {}, warn() {}, error() {} };
const cooldownMap = new Map();
const getCooldown = (key) => cooldownMap.get(key) || 0;
const keyId = (key) => key.slice(0, 6);

// ── Wall 3: TPM too low ─────────────────────────────────────────────────────

describe("Wall 3: TPM-based model filtering", () => {
  it("scorer penalizes keys near TPM limit with large requests", () => {
    const scorer = new KeyScorer({
      keys: ["k1", "k2"],
      keyId,
      getCooldown,
      tpmLimit: 12000, // Groq 70b free-tier
      rpmLimit: 30,
      logger: silent,
    });

    // Simulate k1 already used 10K tokens this minute
    scorer.windows.get("k1").record(1, 10000);

    // Score both keys for a 5K token request
    const s1 = scorer._scoreKey("k1", Date.now(), null, 5000);
    const s2 = scorer._scoreKey("k2", Date.now(), null, 5000);

    // k2 should score much higher (it has full TPM budget)
    assert.ok(s2 > s1, `fresh key (${s2.toFixed(2)}) should score higher than near-limit key (${s1.toFixed(2)})`);
  });

  it("preflight rejects when estimated tokens exceed TPM", () => {
    const scorer = new KeyScorer({
      keys: ["k1"],
      keyId,
      getCooldown,
      tpmLimit: 12000,
      rpmLimit: 30,
      logger: silent,
    });

    // Request with 15K tokens on a 12K TPM provider
    const check = scorer.preflightCheck("k1", null, 15000);
    assert.equal(check.ok, false, "should reject when tokens > TPM");
    assert.ok(check.tpmRemaining < 15000, "TPM remaining should be less than request");
  });

  it("preflight passes when tokens fit within TPM", () => {
    const scorer = new KeyScorer({
      keys: ["k1"],
      keyId,
      getCooldown,
      tpmLimit: 60000, // Cerebras
      rpmLimit: 30,
      logger: silent,
    });

    const check = scorer.preflightCheck("k1", null, 20000);
    assert.equal(check.ok, true, "20K tokens should fit in 60K TPM");
  });
});

// ── Wall 4: Context window minimum ──────────────────────────────────────────

describe("Wall 4: Context window minimum for agents", () => {
  // This is tested in model-discovery.test.js but let's verify the constant
  it("MIN_CONTEXT_WINDOW is 32768 (32K)", () => {
    // Read the constant from model-discovery module internals
    // We test the effect: 8K models get filtered
    const ModelDiscovery = require("../lib/model-discovery");

    // Create a minimal mock pool
    const mockPool = {
      providerNames: () => [],
      getProvider: () => null,
      _upstreamUrls: {},
    };
    const d = new ModelDiscovery({ pool: mockPool, logger: silent });

    // 8K context should be filtered
    const small = d._filterModels([{ id: "test-model", context_window: 8192 }], "test");
    assert.equal(small.length, 0, "8K context should be filtered for agent use");

    // 32K context should pass
    const ok = d._filterModels([{ id: "test-model", context_window: 32768 }], "test");
    assert.equal(ok.length, 1, "32K context should pass");

    // 0 (unknown) should pass (might be fine, we don't know)
    const unknown = d._filterModels([{ id: "test-model", context_window: 0 }], "test");
    assert.equal(unknown.length, 1, "unknown context (0) should pass");
  });
});

// ── Wall 5: Shared-quota detection ──────────────────────────────────────────

describe("Wall 5: Shared-quota key detection", () => {
  it("warns when 80%+ keys hit 429 within 5 seconds", () => {
    const warnings = [];
    const logger = {
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };

    const scorer = new KeyScorer({
      keys: ["k1", "k2", "k3", "k4", "k5"],
      keyId,
      getCooldown,
      rpmLimit: 10,
      logger,
    });

    // Simulate all 5 keys hitting 429 rapidly (shared project)
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) {
      scorer.recordError(key, 429);
    }

    const sharedWarning = warnings.find(w => w.includes("share the same project"));
    assert.ok(sharedWarning, "should warn about shared quota");
    // 80% of 5 = 4, so warning fires when 4th key hits 429
    assert.ok(sharedWarning.includes("/5 keys"), `should mention key count, got: ${sharedWarning}`);
  });

  it("does not warn when keys hit 429 at different times", () => {
    const warnings = [];
    const logger = {
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };

    const scorer = new KeyScorer({
      keys: ["k1", "k2", "k3", "k4", "k5"],
      keyId,
      getCooldown,
      rpmLimit: 10,
      logger,
    });

    // Only 2 keys hit 429 (below 80% threshold)
    scorer.recordError("k1", 429);
    scorer.recordError("k2", 429);

    const sharedWarning = warnings.find(w => w.includes("share the same project"));
    assert.equal(sharedWarning, undefined, "should not warn with only 2/5 keys");
  });

  it("only warns once", () => {
    const warnings = [];
    const logger = {
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };

    const scorer = new KeyScorer({
      keys: ["k1", "k2", "k3"],
      keyId,
      getCooldown,
      rpmLimit: 10,
      logger,
    });

    // Trigger twice
    for (const key of ["k1", "k2", "k3"]) scorer.recordError(key, 429);
    for (const key of ["k1", "k2", "k3"]) scorer.recordError(key, 429);

    const sharedWarnings = warnings.filter(w => w.includes("share the same project"));
    assert.equal(sharedWarnings.length, 1, "should only warn once");
  });

  it("skips check for providers with fewer than 3 keys", () => {
    const warnings = [];
    const logger = {
      log() {},
      warn(msg) { warnings.push(msg); },
      error() {},
    };

    const scorer = new KeyScorer({
      keys: ["k1", "k2"],
      keyId,
      getCooldown,
      rpmLimit: 10,
      logger,
    });

    scorer.recordError("k1", 429);
    scorer.recordError("k2", 429);

    const sharedWarning = warnings.find(w => w.includes("share the same project"));
    assert.equal(sharedWarning, undefined, "should not check with only 2 keys");
  });
});
