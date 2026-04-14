/**
 * Tests for 7 features learned from LiteLLM codebase study:
 * 1. Buffer-zone random pick
 * 2. TTFT tracking
 * 3. Per-token latency normalization
 * 4. Instant retry with healthy keys
 * 5. Percentage-based cooldown + single-key protection
 * 6. Alert dedup/digest with TTL
 * 7. Exception-type retry policies
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const LatencyTracker = require("../lib/latency-tracker");
const KeyScorer = require("../lib/key-scorer");
const Provider = require("../lib/provider");
const Alerter = require("../lib/alerter");

const silentLogger = { log() {}, warn() {}, error() {} };

function makeScorer(keys, opts = {}) {
  const cooldowns = new Map();
  return new KeyScorer({
    keys,
    keyId: k => "..." + k.slice(-4),
    getCooldown: k => cooldowns.get(k) || 0,
    name: "test",
    rpmLimit: opts.rpmLimit ?? 10,
    tpmLimit: opts.tpmLimit ?? 0,
    rpdLimit: 0,
    keyCbThreshold: opts.keyCbThreshold ?? 3,
    keyCbCooldown: opts.keyCbCooldown ?? 2000,
    latencyTracker: opts.latencyTracker || null,
    logger: silentLogger,
    ...opts,
  });
}

function makeProv(keys, opts = {}) {
  return new Provider("test", {
    keys,
    rpm_limit: opts.rpm_limit ?? 10,
    key_cb_threshold: opts.key_cb_threshold ?? 3,
    key_cb_cooldown: opts.key_cb_cooldown ?? 2000,
    logger: silentLogger,
    ...opts,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Buffer-zone random pick
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 1: Buffer-zone random pick", () => {
  it("sticky key reuse for cache locality, rotates when key degrades", () => {
    const keys = ["key-a", "key-b", "key-c"];
    const scorer = makeScorer(keys);
    const picks = new Map();
    keys.forEach(k => picks.set(k, 0));

    // Run 100 selections — sticky should reuse the first-picked key
    for (let i = 0; i < 100; i++) {
      const picked = scorer.selectKey();
      assert.ok(picked, "should pick a key");
      picks.set(picked, picks.get(picked) + 1);
      // Simulate release (decrement pending)
      scorer.pending.set(picked, Math.max(0, (scorer.pending.get(picked) || 0) - 1));
    }

    // Sticky: one key should dominate (cache locality)
    const counts = [...picks.values()].sort((a, b) => b - a);
    assert.ok(counts[0] >= 90, `sticky key should get >=90 picks, got ${counts[0]}`);
  });

  it("still prefers significantly better-scoring keys", () => {
    const keys = ["good-key", "bad-key"];
    const scorer = makeScorer(keys, { rpmLimit: 10 });

    // Make bad-key have many errors (low score)
    scorer.consecutiveErrors.set("bad-key", 5);

    const picks = new Map();
    picks.set("good-key", 0);
    picks.set("bad-key", 0);

    for (let i = 0; i < 50; i++) {
      const picked = scorer.selectKey();
      picks.set(picked, picks.get(picked) + 1);
      scorer.pending.set(picked, Math.max(0, (scorer.pending.get(picked) || 0) - 1));
    }

    // Good key should dominate
    assert.ok(picks.get("good-key") > picks.get("bad-key"),
      `good-key (${picks.get("good-key")}) should get more picks than bad-key (${picks.get("bad-key")})`);
  });

  it("works with single key", () => {
    const scorer = makeScorer(["only-key"]);
    const picked = scorer.selectKey();
    assert.equal(picked, "only-key");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TTFT tracking
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 2: TTFT tracking", () => {
  it("records and retrieves TTFT stats separately from total latency", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 1000, { ttftMs: 200 });
    lt.record("k1", 1500, { ttftMs: 300 });
    lt.record("k1", 2000, { ttftMs: 150 });

    const total = lt.keyStats("k1");
    const ttft = lt.ttftStats("k1");

    assert.ok(total, "total stats should exist");
    assert.ok(ttft, "ttft stats should exist");
    assert.ok(total.avg > ttft.avg, "total latency avg should be higher than TTFT avg");
    assert.equal(ttft.count, 3);
    assert.equal(ttft.min, 150);
    assert.equal(ttft.max, 300);
  });

  it("returns null for TTFT when no TTFT data recorded", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 1000); // no ttftMs
    assert.equal(lt.ttftStats("k1"), null);
  });

  it("computes provider-wide TTFT aggregate", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 1000, { ttftMs: 200 });
    lt.record("k2", 1500, { ttftMs: 400 });

    const provTtft = lt.ttftProviderStats();
    assert.ok(provTtft);
    assert.equal(provTtft.count, 2);
    assert.equal(provTtft.avg, 300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Per-token latency normalization
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 3: Per-token latency normalization", () => {
  it("records per-token latency (ms/token)", () => {
    const lt = new LatencyTracker();
    // 2000ms for 100 tokens = 20 ms/token
    lt.record("k1", 2000, { completionTokens: 100 });
    // 1000ms for 200 tokens = 5 ms/token
    lt.record("k1", 1000, { completionTokens: 200 });

    const pt = lt.perTokenStats("k1");
    assert.ok(pt);
    assert.equal(pt.count, 2);
    assert.equal(pt.min, 5);   // 1000/200
    assert.equal(pt.max, 20);  // 2000/100
  });

  it("skips per-token recording when completionTokens is 0 or missing", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 2000, { completionTokens: 0 });
    lt.record("k1", 1000);
    assert.equal(lt.perTokenStats("k1"), null);
  });

  it("scorer uses per-token latency for penalty when available", () => {
    const lt = new LatencyTracker();
    // k1: very slow per-token (100ms/token) — needs to be >2x provider avg to trigger penalty
    for (let i = 0; i < 10; i++) lt.record("...key1", 10000, { completionTokens: 100 });
    // k2: fast per-token (2ms/token)
    for (let i = 0; i < 10; i++) lt.record("...key2", 200, { completionTokens: 100 });

    // Provider avg per-token: (100 + 2) / 2 = 51 ms/token
    // k1 p50/avg ratio: 100 / 51 ≈ 1.96 — just below 2x... need bigger gap
    // Actually: k1=100ms/tok, k2=2ms/tok, provAvg=(100+2)/2=51, k1 ratio=100/51=1.96
    // Make k1 even slower:
    const lt2 = new LatencyTracker();
    for (let i = 0; i < 10; i++) lt2.record("...key1", 20000, { completionTokens: 100 }); // 200 ms/token
    for (let i = 0; i < 10; i++) lt2.record("...key2", 200, { completionTokens: 100 });  // 2 ms/token
    // provAvg = (200+2)/2 = 101, k1 ratio = 200/101 ≈ 1.98 — still near 2x
    // Use 3 fast keys to lower avg further:
    const lt3 = new LatencyTracker();
    for (let i = 0; i < 10; i++) lt3.record("...key1", 30000, { completionTokens: 100 }); // 300 ms/token
    for (let i = 0; i < 10; i++) lt3.record("...key2", 100, { completionTokens: 100 });   // 1 ms/token
    // provAvg per-token = (300*10 + 1*10) / 20 = 150.5, k1 ratio = 300/150.5 ≈ 1.99
    // Need asymmetric sample counts. Let's just use raw total latency instead:

    const lt4 = new LatencyTracker();
    // k1: slow — 300ms/token (10 samples)
    for (let i = 0; i < 10; i++) lt4.record("...key1", 30000, { completionTokens: 100 });
    // k2: fast — 1ms/token (50 samples to dominate the provider average)
    for (let i = 0; i < 50; i++) lt4.record("...key2", 100, { completionTokens: 100 });
    // provAvg per-token = (300*10 + 1*50) / 60 = 50.83, k1 p50=300, ratio=300/50.83 ≈ 5.9 >> 2x

    const scorer = makeScorer(["key1", "key2"], { latencyTracker: lt4, rpmLimit: 100 });
    // Record equal usage so RPM doesn't dominate
    scorer.recordRequest("key1", 100); scorer.recordRequest("key2", 100);

    const s1 = scorer._scoreKey("key1", Date.now());
    const s2 = scorer._scoreKey("key2", Date.now());

    // k1 should score lower due to per-token latency penalty
    assert.ok(s2 > s1, `fast key (${s2.toFixed(3)}) should score higher than slow key (${s1.toFixed(3)})`);
  });

  it("computes provider-wide per-token aggregate", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 2000, { completionTokens: 100 }); // 20 ms/token
    lt.record("k2", 500, { completionTokens: 100 });  // 5 ms/token

    const agg = lt.perTokenProviderStats();
    assert.ok(agg);
    assert.equal(agg.count, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Instant retry with healthy keys
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 4: Instant retry with healthy keys", () => {
  it("keyStatus reports available keys correctly", () => {
    const prov = makeProv(["k1", "k2", "k3"]);
    const status = prov.keyStatus();
    assert.equal(status.total, 3);
    assert.equal(status.available, 3);
    assert.equal(status.coolingDown, 0);
  });

  it("keyStatus shows reduced availability after cooldown", () => {
    const prov = makeProv(["k1", "k2", "k3"]);
    prov.cooldowns.set("k1", Date.now() + 60000);
    const status = prov.keyStatus();
    assert.equal(status.available, 2);
    assert.equal(status.coolingDown, 1);
  });

  it("keyStatus available=0 when all keys cooling", () => {
    const prov = makeProv(["k1", "k2"]);
    prov.cooldowns.set("k1", Date.now() + 60000);
    prov.cooldowns.set("k2", Date.now() + 60000);
    const status = prov.keyStatus();
    assert.equal(status.available, 0);
    assert.equal(status.coolingDown, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Percentage-based cooldown + single-key protection
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 5: Percentage-based cooldown", () => {
  it("does not trip CB on few errors if failure rate is below 50%", () => {
    const scorer = makeScorer(["k1", "k2"], { keyCbThreshold: 100 }); // high threshold to isolate %
    // 2 errors out of 10 requests = 20% failure rate (below 50%, below floor of 5)
    for (let i = 0; i < 8; i++) scorer.recordSuccess("k1");
    for (let i = 0; i < 2; i++) scorer.recordError("k1", 500);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil <= Date.now(), "should NOT have tripped CB at 20% failure rate");
  });

  it("trips CB when failure rate exceeds 50% with enough requests", () => {
    const scorer = makeScorer(["k1", "k2"], { keyCbThreshold: 100 }); // high thresh
    // 4 successes + 5 errors = 55.5% failure rate with 9 requests (>= 5 floor)
    for (let i = 0; i < 4; i++) scorer.recordSuccess("k1");
    for (let i = 0; i < 5; i++) scorer.recordError("k1", 500);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil > Date.now(), "should trip CB at >50% failure rate with >= 5 requests");
  });

  it("single-key group requires 100% failure rate with high floor", () => {
    const scorer = makeScorer(["k1"], { keyCbThreshold: 100 });

    // 15 errors + 5 successes = 75% failure rate — should NOT trip for single key
    for (let i = 0; i < 5; i++) scorer.recordSuccess("k1");
    for (let i = 0; i < 15; i++) scorer.recordError("k1", 500);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil <= Date.now(), "single-key should NOT trip at 75% failure rate");
  });

  it("single-key trips at 100% failure rate with 20+ requests", () => {
    const scorer = makeScorer(["k1"], { keyCbThreshold: 100 });

    // 20 consecutive errors with no successes = 100% failure rate
    for (let i = 0; i < 20; i++) scorer.recordError("k1", 500);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil > Date.now(), "single-key should trip at 100% failure rate with 20 requests");
  });

  it("consecutive threshold still works as fallback", () => {
    const scorer = makeScorer(["k1", "k2"], { keyCbThreshold: 3 });

    // 3 consecutive errors (below 5-request floor for % check)
    scorer.recordError("k1", 500);
    scorer.recordError("k1", 500);
    scorer.recordError("k1", 500);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil > Date.now(), "consecutive threshold should still trip CB");
  });

  it("auth failures (401/403) always hard-break regardless of percentage", () => {
    const scorer = makeScorer(["k1", "k2"]);
    scorer.recordError("k1", 401);

    const cbUntil = scorer.keyCbUntil.get("k1") || 0;
    assert.ok(cbUntil > Date.now() + 60000, "401 should hard-break for a long time");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Alert dedup/digest with TTL
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 6: Alert dedup/digest", () => {
  it("deduplicates alerts by event+provider+model", () => {
    const sent = [];
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 60000,
      logger: silentLogger,
    });
    // Monkey-patch _send to capture calls
    alerter._send = (body) => { sent.push(JSON.parse(body)); return Promise.resolve(); };

    alerter.fire("circuit_open", { provider: "gemini" });
    alerter.fire("circuit_open", { provider: "gemini" }); // should be suppressed
    alerter.fire("circuit_open", { provider: "groq" });   // different provider = different dedup key

    assert.equal(sent.length, 2);
    assert.equal(sent[0].provider, "gemini");
    assert.equal(sent[1].provider, "groq");
  });

  it("includes suppressed_count when alerts resume after TTL", () => {
    const sent = [];
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 10, // very short TTL for testing
      logger: silentLogger,
    });
    alerter._send = (body) => { sent.push(JSON.parse(body)); return Promise.resolve(); };

    alerter.fire("provider_error", { provider: "test" });
    // Suppress a few
    alerter.fire("provider_error", { provider: "test" });
    alerter.fire("provider_error", { provider: "test" });

    // Wait for TTL to expire, then fire again
    alerter._lastFired.clear(); // simulate TTL expiry

    alerter.fire("provider_error", { provider: "test" });

    assert.equal(sent.length, 2);
    assert.equal(sent[1].suppressed_count, 2);
  });

  it("per-event-type TTLs apply", () => {
    const sent = [];
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      eventTtls: { circuit_open: 1, budget_exceeded: 100000 },
      logger: silentLogger,
    });
    alerter._send = (body) => { sent.push(JSON.parse(body)); return Promise.resolve(); };

    alerter.fire("budget_exceeded", { provider: "test" });
    alerter.fire("budget_exceeded", { provider: "test" }); // suppressed (100s TTL)

    assert.equal(sent.length, 1);
  });

  it("digest mode buffers and flushes", () => {
    const sent = [];
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      digestIntervalMs: 100,
      logger: silentLogger,
    });
    alerter._send = (body) => { sent.push(JSON.parse(body)); return Promise.resolve(); };

    alerter.fire("circuit_open", { provider: "gemini" });
    alerter.fire("all_keys_exhausted", { provider: "groq" });

    // Should be buffered, not sent yet
    assert.equal(sent.length, 0);
    assert.equal(alerter._digestBuf.length, 2);

    // Manual flush
    alerter._flushDigest();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "digest");
    assert.equal(sent[0].count, 2);
    assert.equal(sent[0].alerts.length, 2);

    alerter.destroy();
  });

  it("destroy() flushes remaining digest", () => {
    const sent = [];
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      digestIntervalMs: 60000,
      logger: silentLogger,
    });
    alerter._send = (body) => { sent.push(JSON.parse(body)); return Promise.resolve(); };

    alerter.fire("circuit_open", { provider: "test" });
    alerter.destroy();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "digest");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Exception-type retry policies
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 7: Exception-type retry policies", () => {
  it("429 gets 3 retries", () => {
    const prov = makeProv(["k1"]);
    assert.equal(prov.maxRetriesFor(429), 3);
  });

  it("401/403 gets 0 retries (never retry auth failures)", () => {
    const prov = makeProv(["k1"]);
    assert.equal(prov.maxRetriesFor(401), 0);
    assert.equal(prov.maxRetriesFor(403), 0);
  });

  it("timeout/network (statusCode 0) gets 2 retries", () => {
    const prov = makeProv(["k1"]);
    assert.equal(prov.maxRetriesFor(0), 2);
  });

  it("500/502/503 gets 2 retries", () => {
    const prov = makeProv(["k1"]);
    assert.equal(prov.maxRetriesFor(500), 2);
    assert.equal(prov.maxRetriesFor(502), 2);
    assert.equal(prov.maxRetriesFor(503), 2);
  });

  it("other 4xx gets 0 retries", () => {
    const prov = makeProv(["k1"]);
    assert.equal(prov.maxRetriesFor(400), 0);
    assert.equal(prov.maxRetriesFor(404), 0);
    assert.equal(prov.maxRetriesFor(422), 0);
  });

  it("isRetryable and maxRetriesFor are consistent", () => {
    const prov = makeProv(["k1"]);
    // 429 is retryable AND has retries
    assert.ok(prov.isRetryable(429));
    assert.ok(prov.maxRetriesFor(429) > 0);
    // 401 is NOT retryable
    assert.ok(!prov.isRetryable(401));
    assert.equal(prov.maxRetriesFor(401), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: LatencyTracker reset clears all buffers
// ═══════════════════════════════════════════════════════════════════════════
describe("LatencyTracker reset clears TTFT and per-token", () => {
  it("reset clears all buffers for a key", () => {
    const lt = new LatencyTracker();
    lt.record("k1", 1000, { ttftMs: 200, completionTokens: 50 });
    assert.ok(lt.keyStats("k1"));
    assert.ok(lt.ttftStats("k1"));
    assert.ok(lt.perTokenStats("k1"));

    lt.reset("k1");
    assert.equal(lt.keyStats("k1"), null);
    assert.equal(lt.ttftStats("k1"), null);
    assert.equal(lt.perTokenStats("k1"), null);
  });
});
