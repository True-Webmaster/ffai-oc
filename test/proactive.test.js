/**
 * Proactive intelligence tests.
 *
 * Tests: in-flight burst protection, x-ratelimit-remaining sync,
 * latency-based scoring, cross-key limit propagation,
 * adaptive retry-after, utilization pressure.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Provider = require("../lib/provider");
const Pool = require("../lib/pool");
const KeyScorer = require("../lib/key-scorer");
const LatencyTracker = require("../lib/latency-tracker");
const path = require("node:path");
const os = require("node:os");

function tmpStats() {
  return path.join(os.tmpdir(), `ffai-proactive-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const silent = { log() {}, warn() {}, error() {} };

// ── 1. In-flight burst protection ─────────────────────────────────────────

describe("In-flight burst protection", () => {
  function makeScorer() {
    return new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });
  }

  it("selectKey increments pending counter", () => {
    const s = makeScorer();
    assert.equal(s.pending.get("k1"), 0);

    const key = s.selectKey();
    assert.equal(s.pending.get(key), 1);
  });

  it("recordRequest decrements pending counter", () => {
    const s = makeScorer();
    const key = s.selectKey();
    assert.equal(s.pending.get(key), 1);

    s.recordRequest(key, 100);
    assert.equal(s.pending.get(key), 0);
  });

  it("pending count never goes below 0", () => {
    const s = makeScorer();
    s.recordRequest("k1", 100); // no prior selectKey
    assert.equal(s.pending.get("k1"), 0);
  });

  it("concurrent selects spread across keys due to pending", () => {
    const s = makeScorer();

    // Select 5 times without releasing — should spread due to pending pressure
    const selected = [];
    for (let i = 0; i < 6; i++) {
      const key = s.selectKey();
      assert.ok(key);
      selected.push(key);
    }

    const k1Count = selected.filter(k => k === "k1").length;
    const k2Count = selected.filter(k => k === "k2").length;
    // Both keys should get some requests (not all on one key)
    assert.ok(k1Count > 0 && k2Count > 0, `should spread: k1=${k1Count}, k2=${k2Count}`);
  });

  it("keyStatuses includes pending count", () => {
    const s = makeScorer();
    s.selectKey();
    s.selectKey();

    const statuses = s.keyStatuses();
    const totalPending = Object.values(statuses).reduce((sum, v) => sum + v.pending, 0);
    assert.equal(totalPending, 2);
  });
});

// ── 2. x-ratelimit-remaining sync ──────────────────────────────────────────

describe("x-ratelimit-remaining sync", () => {
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

  it("syncs window count upward from remaining header", () => {
    const s = makeScorer();
    // Our window thinks 2 requests were made
    s.recordRequest("k1", 100);
    s.recordRequest("k1", 100);
    assert.equal(s.windows.get("k1").totals().requests, 2);

    // Provider says limit=30, remaining=20 → used=10
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "30",
      "x-ratelimit-remaining-requests": "20",
    });

    // Should have synced up to 10
    assert.equal(s.windows.get("k1").totals().requests, 10);
  });

  it("does not sync downward (never reduces count)", () => {
    const s = makeScorer();
    // Our window thinks 15 requests
    for (let i = 0; i < 15; i++) s.recordRequest("k1", 10);
    assert.equal(s.windows.get("k1").totals().requests, 15);

    // Provider says limit=30, remaining=25 → used=5 (less than our 15)
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "30",
      "x-ratelimit-remaining-requests": "25",
    });

    // Should still be 15 (not reduced)
    assert.equal(s.windows.get("k1").totals().requests, 15);
  });

  it("handles remaining=0 correctly", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "10",
      "x-ratelimit-remaining-requests": "0",
    });
    // Provider says 10 used
    assert.equal(s.windows.get("k1").totals().requests, 10);
  });
});

// ── 3. Latency-based scoring ───────────────────────────────────────────────

describe("Latency-based scoring", () => {
  it("penalizes keys with high p50 vs provider average", () => {
    const lt = new LatencyTracker();
    const s = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      latencyTracker: lt,
      logger: silent,
    });

    // k1 is slow (p50 ~5000ms), k2 is fast (p50 ~500ms)
    // Provider average ~2750ms, so k1 at 5000/2750 ≈ 1.8x (borderline)
    // Use even more extreme values: k1=8000ms, k2=500ms, avg≈4250, k1=8000/4250≈1.9x
    // Actually make k1 much slower: 10000ms vs 500ms → avg=5250, ratio=10000/5250≈1.9x
    // Need ratio > 2.0. Use k1=6000, k2=200 → avg=3100, k1.p50/avg=6000/3100≈1.9x
    // Better: k1=10000, k2=100 → avg=5050, ratio=10000/5050≈1.98 still <2
    // The issue: both keys' latency goes into provider avg. Make one key dominant:
    // k1 has 3 samples at 10000, k2 has 10 samples at 200 → avg≈(30000+2000)/13≈2461
    // k1.p50=10000, ratio=10000/2461≈4.06 → penalty triggers
    for (let i = 0; i < 3; i++) lt.record("...k1", 10000);
    for (let i = 0; i < 10; i++) lt.record("...k2", 200);

    // Give equal usage so latency is the differentiator
    s.recordRequest("k1", 100);
    s.recordRequest("k2", 100);
    // Reset lastUsed to equal for fair comparison
    s.lastUsed.set("k1", Date.now());
    s.lastUsed.set("k2", Date.now());

    const now = Date.now();
    const score1 = s._scoreKey("k1", now);
    const score2 = s._scoreKey("k2", now);
    assert.ok(score2 > score1, `fast key should score higher: k1=${score1.toFixed(3)}, k2=${score2.toFixed(3)}`);
  });

  it("no penalty when latency tracker is absent", () => {
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    // Should not throw
    const score = s._scoreKey("k1", Date.now());
    assert.ok(Number.isFinite(score));
  });

  it("no penalty when insufficient latency data", () => {
    const lt = new LatencyTracker();
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      latencyTracker: lt,
      logger: silent,
    });

    // Only one sample — providerStats returns null count
    lt.record("...k1", 5000);

    const score = s._scoreKey("k1", Date.now());
    assert.ok(Number.isFinite(score));
  });
});

// ── 4. Cross-key limit propagation ─────────────────────────────────────────

describe("Cross-key limit propagation", () => {
  it("propagates learned RPM from headers to all keys", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2", "k3"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 30,
      logger: silent,
    });

    // k1 learns a lower limit from headers
    s.ingestRateLimitHeaders("k1", { "x-ratelimit-limit-requests": "10" });

    // Should propagate to k2 and k3
    assert.equal(s.learnedRpm.get("k1"), 10);
    assert.equal(s.learnedRpm.get("k2"), 10);
    assert.equal(s.learnedRpm.get("k3"), 10);
  });

  it("propagates learned RPM from 429 to all keys", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    // Make k1 have enough requests to trigger learning
    for (let i = 0; i < 5; i++) s.recordRequest("k1", 10);
    s.recordError("k1", 429);

    const k1Learned = s.learnedRpm.get("k1");
    const k2Learned = s.learnedRpm.get("k2");
    assert.ok(k1Learned, "k1 should have learned limit");
    assert.equal(k1Learned, k2Learned, "should propagate to k2");
  });

  it("does not increase existing learned limit", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 30,
      logger: silent,
    });

    // k2 already has a lower limit
    s.learnedRpm.set("k2", 5);

    // k1 learns 10 — should not increase k2's limit
    s.ingestRateLimitHeaders("k1", { "x-ratelimit-limit-requests": "10" });
    assert.equal(s.learnedRpm.get("k2"), 5, "should not increase k2's lower limit");
  });
});

// ── 5. Adaptive retry-after ────────────────────────────────────────────────

describe("Adaptive retry-after", () => {
  it("starts with multiplier 1.0", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      logger: silent,
    });
    assert.equal(prov._retryAfterMultiplier, 1.0);
  });

  it("applies multiplier to cooldown duration", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      max_cooldown: 300,
      logger: silent,
    });

    // Force a lower multiplier
    prov._retryAfterMultiplier = 0.5;
    prov.cooldownKey("k1", "60");

    const cooldownUntil = prov.cooldowns.get("k1");
    const expectedMs = 30 * 1000; // 60 * 0.5 = 30s
    const actualMs = cooldownUntil - Date.now();
    assert.ok(Math.abs(actualMs - expectedMs) < 1000, `cooldown should be ~30s, got ${Math.round(actualMs / 1000)}s`);
  });

  it("learns from actual reset times", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      logger: silent,
    });

    // Simulate 5 cooldown cycles where actual wait was ~50% of claimed
    for (let i = 0; i < 5; i++) {
      // Set claimed cooldown
      prov._cooldownClaimed = prov._cooldownClaimed || new Map();
      prov._cooldownClaimed.set("k1", {
        claimed: 60,
        setAt: Date.now() - 30000, // actually waited 30s (50% of 60s)
      });

      // Simulate success after waiting
      prov._learnRetryAfter("k1");
    }

    // After 5 samples (>=3 required), multiplier should have decreased
    assert.ok(prov._retryAfterMultiplier < 1.0, `multiplier should decrease: ${prov._retryAfterMultiplier}`);
    assert.ok(prov._retryAfterMultiplier >= 0.3, `multiplier should not go below 0.3: ${prov._retryAfterMultiplier}`);
  });

  it("clamps multiplier at 0.3 minimum", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      logger: silent,
    });

    // Simulate very fast resets (actual 2s vs claimed 60s)
    for (let i = 0; i < 10; i++) {
      prov._cooldownClaimed = prov._cooldownClaimed || new Map();
      prov._cooldownClaimed.set("k1", {
        claimed: 60,
        setAt: Date.now() - 2000, // actual 2s
      });
      prov._learnRetryAfter("k1");
    }

    assert.ok(prov._retryAfterMultiplier >= 0.3, `should clamp at 0.3: ${prov._retryAfterMultiplier}`);
  });
});

// ── 6. Utilization pressure ────────────────────────────────────────────────

describe("Utilization pressure", () => {
  it("returns 0 when all keys are idle", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    assert.equal(s.utilization(), 0);
  });

  it("returns proportional utilization", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    // k1 at 50% RPM (5 of 10)
    for (let i = 0; i < 5; i++) s.recordRequest("k1", 0);
    // k2 idle

    const util = s.utilization();
    // Average: (0.5 + 0.0) / 2 = 0.25
    assert.ok(util > 0.2 && util < 0.3, `expected ~0.25, got ${util}`);
  });

  it("returns 1.0 when all keys exhausted", () => {
    const cooldowns = new Map();
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: k => cooldowns.get(k) || 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    // Put key in cooldown
    cooldowns.set("k1", Date.now() + 60000);

    assert.equal(s.utilization(), 1.0);
  });

  it("factors pending requests into utilization", () => {
    const s = new KeyScorer({
      keys: ["k1"],
      keyId: k => "..." + k.slice(-2),
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 10,
      logger: silent,
    });

    // Select 5 keys without recording (5 pending)
    for (let i = 0; i < 5; i++) s.selectKey();

    const util = s.utilization();
    assert.ok(util >= 0.4, `should factor pending: ${util}`);
  });

  it("Pool.utilization delegates to scorer", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1", "k2"], rpm_limit: 10, logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const util = pool.utilization("prov1");
    assert.ok(util != null);
    assert.equal(util, 0);
    pool.shutdown();
  });

  it("Pool.utilization returns null for unknown provider", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1"], rpm_limit: 10, logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    assert.equal(pool.utilization("unknown"), null);
    pool.shutdown();
  });
});
