const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Pool = require("../lib/pool");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Use temp file for stats so tests don't pollute project dir
function tmpStatsFile() {
  return path.join(os.tmpdir(), `ffai-test-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makePool(overrides = {}) {
  return new Pool({
    providers: {
      testprov: {
        keys: ["key-aaa-111", "key-bbb-222", "key-ccc-333"],
        rpm_limit: 10,
        tpm_limit: 100000,
        rpd_limit: 1000,
        ...overrides,
      },
    },
    statsFile: tmpStatsFile(),
    statsFlushInterval: 0, // disable auto-flush in tests
    logger: { log() {}, warn() {}, error() {} }, // silent
  });
}

describe("Pool", () => {
  it("acquires and releases keys", () => {
    const pool = makePool();
    const handle = pool.acquire("testprov");
    assert.ok(handle);
    assert.equal(handle.provider, "testprov");
    assert.ok(handle.key.startsWith("key-"));

    pool.release("testprov", handle.key, { success: true, inputTokens: 100 });
    pool.shutdown();
  });

  it("returns null for unknown provider", () => {
    const pool = makePool();
    assert.equal(pool.acquire("nonexistent"), null);
    pool.shutdown();
  });

  it("rotates keys across acquires", () => {
    const pool = makePool();
    const keys = new Set();
    for (let i = 0; i < 9; i++) {
      const h = pool.acquire("testprov");
      assert.ok(h);
      keys.add(h.key);
      pool.release("testprov", h.key, { success: true });
    }
    // Should have used all 3 keys
    assert.equal(keys.size, 3);
    pool.shutdown();
  });

  it("health reports ok when keys available", () => {
    const pool = makePool();
    const h = pool.health();
    assert.equal(h.status, "ok");
    assert.equal(h.providers.testprov.status, "ok");
    assert.equal(h.providers.testprov.keys.total, 3);
    assert.equal(h.providers.testprov.keys.available, 3);
    pool.shutdown();
  });

  it("health reports degraded when all keys exhausted", () => {
    const pool = makePool({ key_cb_threshold: 1, key_cb_cooldown: 60000 });
    // Trip all 3 keys with errors
    for (const suffix of ["111", "222", "333"]) {
      const h = pool.acquire("testprov");
      if (h) {
        pool.release("testprov", h.key, { success: false, statusCode: 500 });
      }
    }
    const h = pool.health();
    assert.equal(h.providers.testprov.status, "degraded");
    pool.shutdown();
  });

  it("tracks stats on acquire/release", () => {
    const pool = makePool();
    const handle = pool.acquire("testprov");
    pool.release("testprov", handle.key, { success: true });

    const handle2 = pool.acquire("testprov");
    pool.release("testprov", handle2.key, { success: false, statusCode: 429, retryAfter: "1" });

    const stats = pool.stats.toJSON();
    const today = new Date().toISOString().slice(0, 10);
    const day = stats.days[today]?.providers?.testprov;
    assert.ok(day);
    assert.equal(day.requests, 2);
    assert.equal(day.rateLimited, 1);
    pool.shutdown();
  });

  it("detailed health includes per-key info", () => {
    const pool = makePool();
    pool.acquire("testprov"); // trigger at least one selection
    const h = pool.healthDetailed();
    assert.ok(h.providers.testprov.perKey);
    const keyIds = Object.keys(h.providers.testprov.perKey);
    assert.equal(keyIds.length, 3);
    pool.shutdown();
  });
});

describe("SlidingWindow", () => {
  const SlidingWindow = require("../lib/sliding-window");

  it("records and sums correctly", () => {
    const w = new SlidingWindow(60000, 60);
    w.record(1, 100);
    w.record(2, 200);
    const t = w.totals();
    assert.equal(t.requests, 3);
    assert.equal(t.tokens, 300);
  });

  it("resets to zero", () => {
    const w = new SlidingWindow(60000, 60);
    w.record(5, 500);
    w.reset();
    const t = w.totals();
    assert.equal(t.requests, 0);
    assert.equal(t.tokens, 0);
  });
});

describe("KeyScorer", () => {
  const KeyScorer = require("../lib/key-scorer");

  function makeScorer() {
    const cooldowns = new Map();
    return new KeyScorer({
      keys: ["k1", "k2", "k3"],
      keyId: k => "..." + k,
      getCooldown: k => cooldowns.get(k) || 0,
      name: "test",
      rpmLimit: 10,
      logger: { log() {}, warn() {} },
    });
  }

  it("selects a key", () => {
    const scorer = makeScorer();
    const key = scorer.selectKey();
    assert.ok(["k1", "k2", "k3"].includes(key));
  });

  it("isolates key after consecutive errors", () => {
    const scorer = makeScorer();
    scorer.recordError("k1", 500);
    scorer.recordError("k1", 500);
    scorer.recordError("k1", 500); // 3 = threshold

    // k1 should be circuit-broken
    const statuses = scorer.keyStatuses();
    assert.match(statuses["...k1"].perKeyCB, /^open/);
  });

  it("resets error counter on success", () => {
    const scorer = makeScorer();
    scorer.recordError("k1", 500);
    scorer.recordError("k1", 500);
    scorer.recordSuccess("k1");
    assert.equal(scorer.consecutiveErrors.get("k1"), 0);
  });
});

describe("Utils", () => {
  const { estimateInputTokens, backoffDelay, formatUptime } = require("../lib/utils");

  it("estimates tokens from messages", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "Hello world" }, // 11 chars
      ],
    });
    const tokens = estimateInputTokens(body);
    assert.ok(tokens > 0);
    assert.ok(tokens < 10); // ~3 tokens for "Hello world"
  });

  it("returns 0 for invalid body", () => {
    assert.equal(estimateInputTokens(""), 0);
    assert.equal(estimateInputTokens("not json"), 0);
    assert.equal(estimateInputTokens(null), 0);
  });

  it("calculates backoff with cap", () => {
    assert.equal(backoffDelay(0), 100);
    assert.equal(backoffDelay(1), 200);
    assert.equal(backoffDelay(2), 400);
    assert.equal(backoffDelay(10), 2000); // capped
  });

  it("formats uptime", () => {
    assert.equal(formatUptime(90000), "1m");
    assert.equal(formatUptime(3700000), "1h 1m");
    assert.equal(formatUptime(90000000), "1d 1h 0m");
  });
});

// ── Exhaustion Signal Tests ──────────────────────────────────────────────────

describe("Pool — Exhaustion Signal", () => {
  it("returns null when all keys exhausted (OpenClaw gets 429)", () => {
    const pool = makePool({ key_cb_threshold: 1, key_cb_cooldown: 60000 });

    // Trip all 3 keys with errors
    for (let i = 0; i < 3; i++) {
      const h = pool.acquire("testprov");
      if (h) {
        pool.release("testprov", h.key, { success: false, statusCode: 500 });
      }
    }

    // All keys exhausted → null (bridge will return 429 "All keys rate limited")
    const result = pool.acquire("testprov");
    assert.equal(result, null);
    pool.shutdown();
  });

  it("records circuitBreaks in stats when all keys CB-open", () => {
    const pool = makePool({ key_cb_threshold: 1, key_cb_cooldown: 60000 });

    // Trip all keys via per-key CB
    for (let i = 0; i < 3; i++) {
      const h = pool.acquire("testprov");
      if (h) pool.release("testprov", h.key, { success: false, statusCode: 500 });
    }

    // Trigger exhaustion recording — CB is open so this records circuitBreaks
    pool.acquire("testprov");

    const today = new Date().toISOString().slice(0, 10);
    const dayStats = pool.stats.data.days[today]?.providers?.testprov;
    assert.ok(dayStats);
    assert.ok(dayStats.circuitBreaks >= 1, "should record circuit break when all keys CB-open");
    pool.shutdown();
  });

});
