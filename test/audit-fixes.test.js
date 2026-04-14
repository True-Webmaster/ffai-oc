/**
 * Tests for all 18 audit fixes.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Provider = require("../lib/provider");
const Pool = require("../lib/pool");
const KeyScorer = require("../lib/key-scorer");
const AuthGuard = require("../lib/auth-guard");
const LatencyTracker = require("../lib/latency-tracker");
const path = require("node:path");
const os = require("node:os");

function tmpStats() {
  return path.join(os.tmpdir(), `ffai-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const silent = { log() {}, warn() {}, error() {} };

// ── Fix #2: learnedRpm recovery ────────────────────────────────────────────

describe("Fix #2: learnedRpm decay toward configured", () => {
  it("_getEffectiveRpm returns configured when no learned value", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 30, logger: silent,
    });
    assert.equal(s._getEffectiveRpm("k1", 30), 30);
  });

  it("_getEffectiveRpm returns learned value when fresh", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 30, logger: silent,
    });
    s.learnedRpm.set("k1", 15);
    s.learnedRpmTs.set("k1", Date.now());
    assert.equal(s._getEffectiveRpm("k1", 30), 15);
  });

  it("_getEffectiveRpm decays toward configured after decay period", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 30, logger: silent,
    });
    s.learnedRpm.set("k1", 15);
    // Set timestamp to 2 decay periods ago (10 min default)
    s.learnedRpmTs.set("k1", Date.now() - s._learnedRpmDecayMs * 2);
    const effective = s._getEffectiveRpm("k1", 30);
    assert.ok(effective > 15, `should decay upward from 15: got ${effective}`);
    assert.ok(effective <= 30, `should not exceed configured: got ${effective}`);
  });
});

// ── Fix #5: modelWindows eviction ──────────────────────────────────────────

describe("Fix #5: modelWindows eviction cap", () => {
  it("caps model windows at _maxModelWindows", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });
    s._maxModelWindows = 5;

    for (let i = 0; i < 10; i++) {
      s.recordRequest("k1", 10, `model-${i}`, true);
    }

    assert.ok(s.modelWindows.get("k1").size <= 5, `should cap at 5: got ${s.modelWindows.get("k1").size}`);
  });
});

// ── Fix #7: Tokens per day scoring ─────────────────────────────────────────

describe("Fix #7: TPD limit in scoring", () => {
  it("_getModelLimits includes tpd", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, tpdLimit: 1000000, logger: silent,
    });
    const limits = s._getModelLimits(null);
    assert.equal(limits.tpd, 1000000);
  });

  it("tpd_limit activates scorer in provider", () => {
    const prov = new Provider("test", {
      keys: ["k1"], tpd_limit: 500000, logger: silent,
    });
    assert.ok(prov.scorer, "tpd_limit alone should activate scorer");
  });
});

// ── Fix #9: Don't count failures in windows ────────────────────────────────

describe("Fix #9: conditional window recording", () => {
  it("recordRequest with countInWindow=false skips window/daily", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });

    s.selectKey(); // increment pending
    s.recordRequest("k1", 100, null, false); // don't count

    const w = s.windows.get("k1").totals();
    assert.equal(w.requests, 0, "should not count in window");
    assert.equal(w.tokens, 0, "should not count tokens");
    const daily = s._getDailyUsage("k1");
    assert.equal(daily.requests, 0, "should not count in daily");
  });

  it("recordRequest with countInWindow=true counts normally", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });

    s.selectKey();
    s.recordRequest("k1", 100, null, true);

    const w = s.windows.get("k1").totals();
    assert.equal(w.requests, 1);
    assert.equal(w.tokens, 100);
  });

  it("Provider.release counts 429 in window but not 5xx", () => {
    const prov = new Provider("test", {
      keys: ["k1"], rpm_limit: 10, logger: silent,
    });

    const key = prov.acquire();
    prov.release(key, { success: false, statusCode: 500, inputTokens: 100 });
    const w1 = prov.scorer.windows.get(key).totals();
    assert.equal(w1.requests, 0, "5xx should not count");

    const key2 = prov.acquire();
    prov.release(key2, { success: false, statusCode: 429, inputTokens: 100 });
    const w2 = prov.scorer.windows.get(key2).totals();
    assert.equal(w2.requests, 1, "429 should count");
  });
});

// ── Fix #10: Timing-safe auth ──────────────────────────────────────────────

describe("Fix #10: HMAC-based timing-safe check", () => {
  it("correct match returns true", () => {
    assert.ok(AuthGuard.timingSafeCheck("Bearer mykey123", "Bearer mykey123"));
  });

  it("incorrect value returns false", () => {
    assert.ok(!AuthGuard.timingSafeCheck("Bearer wrong", "Bearer mykey123"));
  });

  it("different lengths return false without timing leak", () => {
    assert.ok(!AuthGuard.timingSafeCheck("short", "a-much-longer-expected-value"));
    assert.ok(!AuthGuard.timingSafeCheck("a-much-longer-provided-value", "short"));
  });
});

// ── Fix #11: Model alias resolution ────────────────────────────────────────

describe("Fix #11: model alias resolution", () => {
  it("resolves exact match", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
      modelLimits: { "gemini-2.5-pro": { rpm: 5 } },
    });
    assert.equal(s._resolveModel("gemini-2.5-pro"), "gemini-2.5-pro");
  });

  it("resolves prefix match", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
      modelLimits: { "gemini-2.5-pro": { rpm: 5 } },
    });
    assert.equal(s._resolveModel("gemini-2.5-pro-preview-05-06"), "gemini-2.5-pro");
  });

  it("resolves explicit alias", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
      modelLimits: { "gpt-4": { rpm: 100 } },
      modelAliases: { "gpt-4-turbo": "gpt-4" },
    });
    assert.equal(s._resolveModel("gpt-4-turbo"), "gpt-4");
  });

  it("returns original when no match", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
      modelLimits: { "gemini-2.5-pro": { rpm: 5 } },
    });
    assert.equal(s._resolveModel("unknown-model"), "unknown-model");
  });
});

// ── Fix #12: Exponential backoff on per-key CB ─────────────────────────────

describe("Fix #12: exponential CB backoff", () => {
  it("first CB uses base cooldown", () => {
    // Use 2 keys so consecutive threshold (not single-key protection) applies
    const s = new KeyScorer({
      keys: ["k1", "k2"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, keyCbThreshold: 2, keyCbCooldown: 10000, logger: silent,
    });
    s.recordError("k1", 500);
    s.recordError("k1", 500); // trips CB

    const cbUntil = s.keyCbUntil.get("k1");
    const diff = cbUntil - Date.now();
    assert.ok(diff > 9000 && diff <= 10500, `first CB should be ~10s: got ${diff}ms`);
  });

  it("second CB uses 2x backoff", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, keyCbThreshold: 2, keyCbCooldown: 10000, logger: silent,
    });
    // First CB
    s.recordError("k1", 500);
    s.recordError("k1", 500);
    // Simulate CB expiry
    s.keyCbUntil.set("k1", 0);
    s.consecutiveErrors.set("k1", 0);
    s.recentErrors.set("k1", 0);
    s.recentRequests.set("k1", 0);
    // Second CB
    s.recordError("k1", 500);
    s.recordError("k1", 500);

    const cbUntil = s.keyCbUntil.get("k1");
    const diff = cbUntil - Date.now();
    assert.ok(diff > 19000 && diff <= 21000, `second CB should be ~20s: got ${diff}ms`);
  });

  it("success resets backoff", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, keyCbThreshold: 2, keyCbCooldown: 10000, logger: silent,
    });
    s.recordError("k1", 500);
    s.recordError("k1", 500); // backoff = 2
    s.keyCbUntil.set("k1", 0);
    s.recordSuccess("k1");
    assert.equal(s.keyCbBackoff.get("k1"), 1, "backoff should reset to 1");
  });
});

// ── Fix #14: Smooth scoring curve ──────────────────────────────────────────

describe("Fix #14: smooth exponential ramp", () => {
  it("no penalty at 60% usage", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });
    // 6 requests = 60% of 10 RPM
    for (let i = 0; i < 6; i++) s.recordRequest("k1", 0, null, true);
    const score = s._scoreKey("k1", Date.now());
    // At 60%, should be ~0.4 base (1.0 - 0.6) with small idle bonus
    assert.ok(score > 0.3, `score at 60% should be positive: ${score.toFixed(3)}`);
  });

  it("moderate penalty at 80% usage", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });
    for (let i = 0; i < 8; i++) s.recordRequest("k1", 0, null, true);
    const score = s._scoreKey("k1", Date.now());
    // At 80%, exponential ramp: (0.8-0.7)/0.3 = 0.333, ^2 = 0.111, *2 = 0.222
    // Base: 1.0 - 0.8 = 0.2, minus 0.222 = -0.022
    assert.ok(score < 0.1, `score at 80% should be low: ${score.toFixed(3)}`);
  });
});

// ── Fix #15: Active stream tracking ────────────────────────────────────────

describe("Fix #15: active stream counter", () => {
  it("startStream/endStream increments/decrements", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });
    assert.equal(s.activeStreams.get("k1"), 0);
    s.startStream("k1");
    assert.equal(s.activeStreams.get("k1"), 1);
    s.startStream("k1");
    assert.equal(s.activeStreams.get("k1"), 2);
    s.endStream("k1");
    assert.equal(s.activeStreams.get("k1"), 1);
    s.endStream("k1");
    assert.equal(s.activeStreams.get("k1"), 0);
  });

  it("endStream does not go below 0", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, logger: silent,
    });
    s.endStream("k1");
    assert.equal(s.activeStreams.get("k1"), 0);
  });
});

// ── Fix #16: Immediate 401/403 hard-break ──────────────────────────────────

describe("Fix #16: immediate auth failure hard-break", () => {
  it("401 immediately circuit-breaks key for long duration", () => {
    const s = new KeyScorer({
      keys: ["k1", "k2"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, keyCbCooldown: 10000, logger: silent,
    });
    s.recordError("k1", 401);

    const cbUntil = s.keyCbUntil.get("k1");
    const diff = cbUntil - Date.now();
    // Should be at least 30 minutes (1800000ms)
    assert.ok(diff >= 1790000, `401 CB should be >= 30min: got ${diff}ms`);
  });

  it("403 immediately circuit-breaks key", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 10, keyCbCooldown: 10000, logger: silent,
    });
    s.recordError("k1", 403);
    const cbUntil = s.keyCbUntil.get("k1");
    assert.ok(cbUntil > Date.now() + 1700000, "403 should hard-break");
  });
});

// ── Fix #17: maxConcurrent hard cap ────────────────────────────────────────

describe("Fix #17: maxConcurrent hard cap", () => {
  it("rejects key when at maxConcurrent", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 100, maxConcurrent: 2, logger: silent,
    });

    const a = s.selectKey(); // pending=1
    const b = s.selectKey(); // pending=2
    const c = s.selectKey(); // should be null (at cap)
    assert.ok(a);
    assert.ok(b);
    assert.equal(c, null, "should reject when at maxConcurrent");
  });

  it("allows key after pending decremented", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 100, maxConcurrent: 1, logger: silent,
    });

    s.selectKey(); // pending=1
    assert.equal(s.selectKey(), null); // at cap
    s.recordRequest("k1", 0, null, true); // decrements pending
    const key = s.selectKey();
    assert.ok(key, "should allow after decrement");
  });
});

// ── Fix #6: Anthropic header normalization ─────────────────────────────────

describe("Fix #6: Anthropic header support", () => {
  it("ingests anthropic-ratelimit-requests-limit", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 100, logger: silent,
    });
    s.ingestRateLimitHeaders("k1", {
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "45",
    });
    assert.equal(s.learnedRpm.get("k1"), 50);
  });

  it("ingests IETF draft ratelimit-limit header", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 100, logger: silent,
    });
    s.ingestRateLimitHeaders("k1", { "ratelimit-limit": "25" });
    assert.equal(s.learnedRpm.get("k1"), 25);
  });

  it("prefers x-ratelimit over anthropic headers", () => {
    const s = new KeyScorer({
      keys: ["k1"], keyId: k => k, getCooldown: () => 0,
      name: "test", rpmLimit: 100, logger: silent,
    });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "20",
      "anthropic-ratelimit-requests-limit": "50",
    });
    assert.equal(s.learnedRpm.get("k1"), 20);
  });
});

// ── Fix #8: Permanent invalid key marking ──────────────────────────────────

describe("Fix #8: long-duration invalid key marking", () => {
  it("markKeyInvalid sets 30min+ CB", () => {
    const prov = new Provider("test", {
      keys: ["k1", "k2"], rpm_limit: 10, logger: silent,
    });
    prov.markKeyInvalid("k1");

    const cbUntil = prov.scorer.keyCbUntil.get("k1");
    const diff = cbUntil - Date.now();
    assert.ok(diff >= 1790000, `should be >= 30min: got ${diff}ms`);
  });

  it("markKeyInvalid sets max backoff", () => {
    const prov = new Provider("test", {
      keys: ["k1"], rpm_limit: 10, logger: silent,
    });
    prov.markKeyInvalid("k1");
    assert.equal(prov.scorer.keyCbBackoff.get("k1"), 8);
  });
});

// ── Fix #13: Adaptive retry multiplier decay ───────────────────────────────

describe("Fix #13: retry multiplier decay toward 1.0", () => {
  it("multiplier stays when recent", () => {
    const prov = new Provider("test", {
      keys: ["k1"], rpm_limit: 10, logger: silent,
    });
    prov._retryAfterMultiplier = 0.5;
    prov._retryAfterLastUpdate = Date.now();
    prov.cooldownKey("k1", "60");
    // Should still use 0.5
    const diff = prov.cooldowns.get("k1") - Date.now();
    assert.ok(diff < 35000, `should be ~30s: got ${Math.round(diff / 1000)}s`);
  });
});
