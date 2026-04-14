const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const LatencyTracker = require("../lib/latency-tracker");
const Pool = require("../lib/pool");
const path = require("path");
const os = require("os");

function tmpStatsFile() {
  return path.join(os.tmpdir(), `ffai-test-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ── LatencyTracker unit tests ──────────────────────────────────────────────

describe("LatencyTracker", () => {
  it("returns null for empty / unknown key", () => {
    const lt = new LatencyTracker();
    assert.equal(lt.keyStats("nope"), null);
    assert.equal(lt.providerStats(), null);
  });

  it("records and computes correct stats (avg, p50, p95, p99, min, max)", () => {
    const lt = new LatencyTracker();
    // Record 100 values: 1, 2, 3, ..., 100
    for (let i = 1; i <= 100; i++) {
      lt.record("k1", i);
    }
    const s = lt.keyStats("k1");
    assert.equal(s.count, 100);
    assert.equal(s.min, 1);
    assert.equal(s.max, 100);
    assert.equal(s.avg, 51); // Math.round(5050/100)
    assert.equal(s.p50, 50);
    assert.equal(s.p95, 95);
    assert.equal(s.p99, 99);
  });

  it("handles single measurement", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 42);
    const s = lt.keyStats("k1");
    assert.equal(s.count, 1);
    assert.equal(s.avg, 42);
    assert.equal(s.p50, 42);
    assert.equal(s.p95, 42);
    assert.equal(s.p99, 42);
    assert.equal(s.min, 42);
    assert.equal(s.max, 42);
  });

  it("circular buffer evicts old entries", () => {
    const lt = new LatencyTracker(5); // buffer of 5
    // Record 1..5
    for (let i = 1; i <= 5; i++) lt.record("k1", i);
    assert.equal(lt.keyStats("k1").count, 5);
    assert.equal(lt.keyStats("k1").min, 1);

    // Record 3 more — should evict 1, 2, 3
    lt.record("k1", 100);
    lt.record("k1", 200);
    lt.record("k1", 300);
    const s = lt.keyStats("k1");
    assert.equal(s.count, 5); // still capped at 5
    assert.equal(s.min, 4);   // 1,2,3 evicted; remaining: 4, 5, 100, 200, 300
    assert.equal(s.max, 300);
  });

  it("providerStats aggregates across keys", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 10);
    lt.record("k1", 20);
    lt.record("k2", 30);
    lt.record("k2", 40);

    const s = lt.providerStats();
    assert.equal(s.count, 4);
    assert.equal(s.avg, 25); // (10+20+30+40)/4
    assert.equal(s.min, 10);
    assert.equal(s.max, 40);
  });

  it("allKeyStats returns per-key breakdown", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 10);
    lt.record("k2", 20);

    const all = lt.allKeyStats();
    assert.ok(all["k1"]);
    assert.ok(all["k2"]);
    assert.equal(all["k1"].avg, 10);
    assert.equal(all["k2"].avg, 20);
  });

  it("reset clears a key's buffer", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 10);
    lt.reset("k1");
    assert.equal(lt.keyStats("k1"), null);
  });

  it("ignores invalid values (negative, NaN, Infinity)", () => {
    const lt = new LatencyTracker();
    lt.record("k1", -5);
    lt.record("k1", NaN);
    lt.record("k1", Infinity);
    assert.equal(lt.keyStats("k1"), null);
  });

  // ── Per-Model Stats ──────────────────────────────────────────────────────

  it("recording with model populates model buffers", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 100, { model: "gpt-4" });
    lt.record("k1", 200, { model: "gpt-4" });
    const s = lt.modelStats("gpt-4");
    assert.ok(s, "modelStats should return data");
    assert.equal(s.count, 2);
    assert.equal(s.avg, 150);
    assert.equal(s.min, 100);
    assert.equal(s.max, 200);
  });

  it("modelStats() returns correct stats", () => {
    const lt = new LatencyTracker();
    for (let i = 1; i <= 100; i++) {
      lt.record("k1", i, { model: "claude-3" });
    }
    const s = lt.modelStats("claude-3");
    assert.equal(s.count, 100);
    assert.equal(s.avg, 51);
    assert.equal(s.p50, 50);
    assert.equal(s.p95, 95);
    assert.equal(s.min, 1);
    assert.equal(s.max, 100);
  });

  it("modelTtftStats() returns correct stats", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 100, { model: "gpt-4", ttftMs: 20 });
    lt.record("k1", 200, { model: "gpt-4", ttftMs: 40 });
    lt.record("k1", 300, { model: "gpt-4", ttftMs: 60 });
    const s = lt.modelTtftStats("gpt-4");
    assert.ok(s, "modelTtftStats should return data");
    assert.equal(s.count, 3);
    assert.equal(s.avg, 40);
    assert.equal(s.min, 20);
    assert.equal(s.max, 60);
  });

  it("allModelStats() aggregates across models", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 100, { model: "gpt-4", ttftMs: 10, completionTokens: 50 });
    lt.record("k2", 200, { model: "gpt-4", ttftMs: 20, completionTokens: 100 });
    lt.record("k1", 300, { model: "claude-3", completionTokens: 150 });

    const all = lt.allModelStats();
    assert.ok(all["gpt-4"], "gpt-4 should be present");
    assert.ok(all["claude-3"], "claude-3 should be present");

    // gpt-4: latency
    assert.equal(all["gpt-4"].latency.count, 2);
    assert.equal(all["gpt-4"].latency.avg, 150);
    // gpt-4: ttft
    assert.ok(all["gpt-4"].ttft, "gpt-4 should have ttft");
    assert.equal(all["gpt-4"].ttft.count, 2);
    assert.equal(all["gpt-4"].ttft.avg, 15);
    // gpt-4: perToken
    assert.ok(all["gpt-4"].perToken, "gpt-4 should have perToken");
    assert.equal(all["gpt-4"].perToken.count, 2);

    // claude-3: latency
    assert.equal(all["claude-3"].latency.count, 1);
    assert.equal(all["claude-3"].latency.avg, 300);
    // claude-3: no ttft (none provided)
    assert.equal(all["claude-3"].ttft, null);
    // claude-3: perToken
    assert.ok(all["claude-3"].perToken, "claude-3 should have perToken");
    assert.equal(all["claude-3"].perToken.count, 1);
  });

  it("recording without model doesn't populate model buffers", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 100);
    lt.record("k1", 200);
    assert.equal(lt.modelStats("anything"), null);
    const all = lt.allModelStats();
    assert.deepEqual(all, {});
  });

  it("model stats are independent from key stats (different keys, same model)", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 100, { model: "gpt-4" });
    lt.record("k2", 200, { model: "gpt-4" });
    lt.record("k3", 300, { model: "gpt-4" });

    // Key stats are separate per key
    assert.equal(lt.keyStats("k1").count, 1);
    assert.equal(lt.keyStats("k1").avg, 100);
    assert.equal(lt.keyStats("k2").count, 1);
    assert.equal(lt.keyStats("k2").avg, 200);
    assert.equal(lt.keyStats("k3").count, 1);
    assert.equal(lt.keyStats("k3").avg, 300);

    // Model stats merge across all keys
    const ms = lt.modelStats("gpt-4");
    assert.equal(ms.count, 3);
    assert.equal(ms.avg, 200); // (100+200+300)/3
    assert.equal(ms.min, 100);
    assert.equal(ms.max, 300);
  });
});

// ── Integration: Pool release with latencyMs → health shows latency ────────

describe("Pool latency integration", () => {
  function makePool(overrides = {}) {
    return new Pool({
      providers: {
        testprov: {
          keys: ["key-aaa-111", "key-bbb-222"],
          rpm_limit: 10,
          ...overrides,
        },
      },
      statsFile: tmpStatsFile(),
      statsFlushInterval: 0,
      logger: { log() {}, warn() {}, error() {} },
    });
  }

  it("health() shows latency after release with latencyMs", () => {
    const pool = makePool();
    const h1 = pool.acquire("testprov");
    assert.ok(h1);
    pool.release("testprov", h1.key, { success: true, inputTokens: 100, latencyMs: 250 });

    const h2 = pool.acquire("testprov");
    assert.ok(h2);
    pool.release("testprov", h2.key, { success: true, inputTokens: 50, latencyMs: 150 });

    const health = pool.health();
    const lat = health.providers.testprov.latency;
    assert.ok(lat, "latency should be present in health");
    assert.equal(lat.count, 2);
    assert.equal(lat.avg, 200); // (250+150)/2
    assert.equal(lat.min, 150);
    assert.equal(lat.max, 250);
    pool.shutdown();
  });

  it("health() shows null latency when no requests have been made", () => {
    const pool = makePool();
    const health = pool.health();
    assert.equal(health.providers.testprov.latency, null);
    pool.shutdown();
  });

  it("healthDetailed() includes per-key latency", () => {
    const pool = makePool();
    const h1 = pool.acquire("testprov");
    pool.release("testprov", h1.key, { success: true, latencyMs: 100 });
    const h2 = pool.acquire("testprov");
    pool.release("testprov", h2.key, { success: true, latencyMs: 300 });

    const detailed = pool.healthDetailed();
    const perKey = detailed.providers.testprov.perKey;
    assert.ok(perKey, "perKey should be present");

    // At least one key should have latency data
    const keyIds = Object.keys(perKey);
    const withLatency = keyIds.filter(kid => perKey[kid].latency != null);
    assert.ok(withLatency.length > 0, "at least one key should have latency");
    pool.shutdown();
  });

  it("stats.recordLatency tracks daily latency", () => {
    const pool = makePool();
    const h1 = pool.acquire("testprov");
    pool.release("testprov", h1.key, { success: true, latencyMs: 200 });

    const stats = pool.stats.toJSON();
    const today = new Date().toISOString().slice(0, 10);
    const day = stats.days[today]?.providers?.testprov;
    assert.ok(day.latency, "day should have latency aggregate");
    assert.equal(day.latency.count, 1);
    assert.equal(day.latency.totalMs, 200);
    assert.equal(day.latency.minMs, 200);
    assert.equal(day.latency.maxMs, 200);
    pool.shutdown();
  });
});
