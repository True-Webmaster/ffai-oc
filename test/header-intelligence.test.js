/**
 * Tests for Feature 2: Full Header Intelligence (TPM learning + Groq RPD fix).
 *
 * Covers:
 * - TPM header ingestion and cross-key propagation
 * - Groq RPD detection (value > 1000 treated as daily, not per-minute)
 * - Cerebras day-specific headers stored as RPD
 * - TPM decay behavior (returns toward configured after 5 min)
 * - RPD learning from headers
 * - Scoring uses learned TPM/RPD values
 * - Reset clears learned values
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const KeyScorer = require("../lib/key-scorer");

const silent = { log() {}, warn() {}, error() {} };

function makeScorer(opts = {}) {
  return new KeyScorer({
    keys: opts.keys || ["k1", "k2"],
    keyId: k => k,
    getCooldown: () => 0,
    name: opts.name || "test",
    rpmLimit: opts.rpmLimit || 60,
    tpmLimit: opts.tpmLimit || 100000,
    rpdLimit: opts.rpdLimit || 1000,
    logger: silent,
    ...opts,
  });
}

// ── TPM header ingestion and cross-key propagation ──────────────────────────

describe("TPM header ingestion", () => {
  it("learns TPM from x-ratelimit-limit-tokens header", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-tokens": "50000",
      "x-ratelimit-remaining-tokens": "45000",
    });
    assert.equal(s.learnedTpm.get("k1"), 50000);
  });

  it("learns TPM from anthropic-ratelimit-tokens-limit header", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", {
      "anthropic-ratelimit-tokens-limit": "80000",
      "anthropic-ratelimit-tokens-remaining": "70000",
    });
    assert.equal(s.learnedTpm.get("k1"), 80000);
  });

  it("propagates learned TPM to other keys", () => {
    const s = makeScorer({ keys: ["k1", "k2", "k3"] });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-tokens": "50000",
    });
    assert.equal(s.learnedTpm.get("k1"), 50000);
    assert.equal(s.learnedTpm.get("k2"), 50000, "should propagate to k2");
    assert.equal(s.learnedTpm.get("k3"), 50000, "should propagate to k3");
  });

  it("only propagates TPM downward", () => {
    const s = makeScorer({ keys: ["k1", "k2"] });
    // k2 already learned a lower value
    s.learnedTpm.set("k2", 30000);
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-tokens": "50000",
    });
    assert.equal(s.learnedTpm.get("k2"), 30000, "should not overwrite lower learned TPM");
  });

  it("syncs token window from remaining-tokens header", () => {
    const s = makeScorer();
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-tokens": "50000",
      "x-ratelimit-remaining-tokens": "40000",
    });
    // Provider says 10000 tokens used; our window was at 0
    const totals = s.windows.get("k1").totals();
    assert.equal(totals.tokens, 10000, "should sync token count from remaining header");
  });
});

// ── Groq RPD detection ──────────────────────────────────────────────────────

describe("Groq RPD detection", () => {
  it("treats x-ratelimit-limit-requests > 1000 as RPD for Groq", () => {
    const s = makeScorer({ name: "groq", rpdLimit: 20000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "14400",
      "x-ratelimit-remaining-requests": "14000",
    });
    assert.equal(s.learnedRpd.get("k1"), 14400, "should store as RPD, not RPM");
    assert.equal(s.learnedRpm.has("k1"), false, "should NOT store as RPM");
  });

  it("treats x-ratelimit-limit-requests <= 1000 as RPM for Groq", () => {
    const s = makeScorer({ name: "groq" });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "30",
      "x-ratelimit-remaining-requests": "25",
    });
    assert.equal(s.learnedRpm.get("k1"), 30, "should store as RPM");
    assert.equal(s.learnedRpd.has("k1"), false, "should NOT store as RPD");
  });

  it("syncs daily usage from Groq remaining header", () => {
    const s = makeScorer({ name: "groq", rpdLimit: 20000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "14400",
      "x-ratelimit-remaining-requests": "14000",
    });
    const daily = s._getDailyUsage("k1");
    assert.equal(daily.requests, 400, "should sync daily requests from remaining");
  });

  it("propagates Groq RPD to other keys", () => {
    const s = makeScorer({ name: "groq", keys: ["k1", "k2"], rpdLimit: 20000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "14400",
    });
    assert.equal(s.learnedRpd.get("k2"), 14400, "should propagate RPD to k2");
  });

  it("non-Groq provider treats value > 1000 as normal RPM", () => {
    const s = makeScorer({ name: "openai", rpmLimit: 5000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "3000",
    });
    assert.equal(s.learnedRpm.get("k1"), 3000, "should store as RPM for non-Groq");
    assert.equal(s.learnedRpd.has("k1"), false, "should NOT store as RPD for non-Groq");
  });
});

// ── Cerebras day-specific headers ─────────────────────────────────────────

describe("Cerebras day-specific headers", () => {
  it("stores x-ratelimit-limit-requests-day as RPD", () => {
    const s = makeScorer({ name: "cerebras", rpdLimit: 10000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests-day": "5000",
      "x-ratelimit-remaining-requests-day": "4500",
    });
    assert.equal(s.learnedRpd.get("k1"), 5000, "should store day header as RPD");
  });

  it("syncs daily usage from remaining-requests-day header", () => {
    const s = makeScorer({ name: "cerebras", rpdLimit: 10000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests-day": "5000",
      "x-ratelimit-remaining-requests-day": "4500",
    });
    const daily = s._getDailyUsage("k1");
    assert.equal(daily.requests, 500, "should sync daily requests from day remaining");
  });

  it("propagates Cerebras RPD to other keys", () => {
    const s = makeScorer({ name: "cerebras", keys: ["k1", "k2", "k3"], rpdLimit: 10000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests-day": "5000",
    });
    assert.equal(s.learnedRpd.get("k2"), 5000);
    assert.equal(s.learnedRpd.get("k3"), 5000);
  });

  it("can ingest both RPM and day headers together", () => {
    const s = makeScorer({ name: "cerebras", rpdLimit: 10000 });
    s.ingestRateLimitHeaders("k1", {
      "x-ratelimit-limit-requests": "30",
      "x-ratelimit-remaining-requests": "28",
      "x-ratelimit-limit-requests-day": "5000",
      "x-ratelimit-remaining-requests-day": "4500",
    });
    assert.equal(s.learnedRpm.get("k1"), 30, "should learn RPM from standard header");
    assert.equal(s.learnedRpd.get("k1"), 5000, "should learn RPD from day header");
  });
});

// ── TPM decay behavior ──────────────────────────────────────────────────────

describe("TPM decay behavior", () => {
  it("returns learned TPM when fresh", () => {
    const s = makeScorer({ tpmLimit: 100000 });
    s.learnedTpm.set("k1", 50000);
    s.learnedTpmTs.set("k1", Date.now());
    assert.equal(s._getEffectiveTpm("k1", 100000), 50000);
  });

  it("returns configured TPM when no learned value", () => {
    const s = makeScorer({ tpmLimit: 100000 });
    assert.equal(s._getEffectiveTpm("k1", 100000), 100000);
  });

  it("decays toward configured TPM after decay period", () => {
    const s = makeScorer({ tpmLimit: 100000 });
    s.learnedTpm.set("k1", 50000);
    s.learnedTpmTs.set("k1", Date.now() - s._learnedRpmDecayMs * 2);
    const effective = s._getEffectiveTpm("k1", 100000);
    assert.ok(effective > 50000, `should decay upward from 50000: got ${effective}`);
    assert.ok(effective <= 100000, `should not exceed configured: got ${effective}`);
  });

  it("returns learned value unchanged within decay window", () => {
    const s = makeScorer({ tpmLimit: 100000 });
    s.learnedTpm.set("k1", 50000);
    s.learnedTpmTs.set("k1", Date.now() - 1000); // 1 second ago
    assert.equal(s._getEffectiveTpm("k1", 100000), 50000, "should not decay within window");
  });
});

// ── RPD decay behavior ──────────────────────────────────────────────────────

describe("RPD learning and decay", () => {
  it("returns learned RPD when fresh", () => {
    const s = makeScorer({ rpdLimit: 10000 });
    s.learnedRpd.set("k1", 5000);
    s.learnedRpdTs.set("k1", Date.now());
    assert.equal(s._getEffectiveRpd("k1", 10000), 5000);
  });

  it("returns configured RPD when no learned value", () => {
    const s = makeScorer({ rpdLimit: 10000 });
    assert.equal(s._getEffectiveRpd("k1", 10000), 10000);
  });

  it("decays toward configured RPD after decay period", () => {
    const s = makeScorer({ rpdLimit: 10000 });
    s.learnedRpd.set("k1", 5000);
    s.learnedRpdTs.set("k1", Date.now() - s._learnedRpmDecayMs * 3);
    const effective = s._getEffectiveRpd("k1", 10000);
    assert.ok(effective > 5000, `should decay upward: got ${effective}`);
    assert.ok(effective <= 10000, `should not exceed configured: got ${effective}`);
  });
});

// ── Scoring uses learned TPM/RPD values ─────────────────────────────────────

describe("Scoring uses learned TPM/RPD", () => {
  it("score penalizes key more with learned (lower) TPM", () => {
    const s = makeScorer({ tpmLimit: 100000 });
    // Record some token usage
    s.windows.get("k1").record(0, 40000);
    const scoreDefault = s._scoreKey("k1", Date.now());

    // Now learn a lower TPM limit
    s.learnedTpm.set("k1", 50000);
    s.learnedTpmTs.set("k1", Date.now());
    const scoreLearned = s._scoreKey("k1", Date.now());

    assert.ok(scoreLearned < scoreDefault,
      `learned TPM should reduce score: default=${scoreDefault}, learned=${scoreLearned}`);
  });

  it("score penalizes key more with learned (lower) RPD", () => {
    const s = makeScorer({ rpdLimit: 10000 });
    // Record some daily usage
    const daily = s._getDailyUsage("k1");
    daily.requests = 4000;
    const scoreDefault = s._scoreKey("k1", Date.now());

    // Now learn a lower RPD limit
    s.learnedRpd.set("k1", 5000);
    s.learnedRpdTs.set("k1", Date.now());
    const scoreLearned = s._scoreKey("k1", Date.now());

    assert.ok(scoreLearned < scoreDefault,
      `learned RPD should reduce score: default=${scoreDefault}, learned=${scoreLearned}`);
  });
});

// ── keyStatuses includes learned values ──────────────────────────────────────

describe("keyStatuses includes learned TPM and RPD", () => {
  it("reports learnedTpm and learnedRpd", () => {
    const s = makeScorer();
    s.learnedTpm.set("k1", 50000);
    s.learnedRpd.set("k1", 5000);
    const statuses = s.keyStatuses();
    assert.equal(statuses["k1"].learnedTpm, 50000);
    assert.equal(statuses["k1"].learnedRpd, 5000);
    assert.equal(statuses["k2"].learnedTpm, null);
    assert.equal(statuses["k2"].learnedRpd, null);
  });
});

// ── Reset clears learned values ──────────────────────────────────────────────

describe("reset() clears all learned state", () => {
  it("clears learnedRpm, learnedTpm, learnedRpd and timestamps", () => {
    const s = makeScorer();
    s.learnedRpm.set("k1", 20);
    s.learnedRpmTs.set("k1", Date.now());
    s.learnedTpm.set("k1", 50000);
    s.learnedTpmTs.set("k1", Date.now());
    s.learnedRpd.set("k1", 5000);
    s.learnedRpdTs.set("k1", Date.now());
    s.consecutiveErrors.set("k1", 5);
    s.windows.get("k1").record(10, 5000);

    s.reset("k1");

    assert.equal(s.learnedRpm.has("k1"), false, "learnedRpm should be cleared");
    assert.equal(s.learnedRpmTs.has("k1"), false, "learnedRpmTs should be cleared");
    assert.equal(s.learnedTpm.has("k1"), false, "learnedTpm should be cleared");
    assert.equal(s.learnedTpmTs.has("k1"), false, "learnedTpmTs should be cleared");
    assert.equal(s.learnedRpd.has("k1"), false, "learnedRpd should be cleared");
    assert.equal(s.learnedRpdTs.has("k1"), false, "learnedRpdTs should be cleared");
    assert.equal(s.consecutiveErrors.get("k1"), 0, "errors should be reset");
    assert.equal(s.pending.get("k1"), 0, "pending should be reset");
    assert.equal(s.activeStreams.get("k1"), 0, "streams should be reset");
  });

  it("does not affect other keys", () => {
    const s = makeScorer();
    s.learnedTpm.set("k1", 50000);
    s.learnedTpm.set("k2", 60000);
    s.learnedRpd.set("k2", 3000);

    s.reset("k1");

    assert.equal(s.learnedTpm.get("k2"), 60000, "k2 TPM should be unaffected");
    assert.equal(s.learnedRpd.get("k2"), 3000, "k2 RPD should be unaffected");
  });
});
