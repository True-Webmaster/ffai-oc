/**
 * Tests for production hardening fixes:
 * - CapabilityStore LRU eviction (bounded memory)
 * - Alerter dedup map cleanup (bounded memory)
 * - Config validation
 * - Graceful drain (shutdown improvements)
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const CapabilityStore = require("../lib/capabilities");
const Alerter = require("../lib/alerter");

const silent = { log() {}, warn() {}, error() {} };

// ── CapabilityStore bounded memory ──────────────────────────────────────────

describe("CapabilityStore eviction", () => {
  it("evicts oldest entries when maxModels exceeded", () => {
    const store = new CapabilityStore({ logger: silent, maxModels: 5 });

    for (let i = 0; i < 10; i++) {
      store.ingestFromDiscovery(`model-${i}`, "prov", {
        contextWindow: 128000,
        maxOutputTokens: 4096,
        inputTypes: ["text"],
      });
    }

    assert.equal(store.size, 5, "should cap at maxModels");
    // First 5 models should be evicted, last 5 should remain
    assert.equal(store.getModel("model-0"), null, "oldest model should be evicted");
    assert.equal(store.getModel("model-4"), null, "model-4 should be evicted");
    assert.ok(store.getModel("model-5"), "model-5 should still exist");
    assert.ok(store.getModel("model-9"), "model-9 should still exist");
  });

  it("LRU touch: accessing a model moves it to end", () => {
    const store = new CapabilityStore({ logger: silent, maxModels: 3 });

    store.ingestFromDiscovery("model-a", "prov", { contextWindow: 100 });
    store.ingestFromDiscovery("model-b", "prov", { contextWindow: 200 });
    store.ingestFromDiscovery("model-c", "prov", { contextWindow: 300 });

    // Touch model-a (moves it to end in LRU order)
    store.ingestFromHeaders("model-a", "prov", { rpm: 10 });

    // Now add a new model — should evict model-b (oldest untouched)
    store.ingestFromDiscovery("model-d", "prov", { contextWindow: 400 });

    assert.equal(store.size, 3);
    assert.ok(store.getModel("model-a"), "model-a should survive (was touched)");
    assert.equal(store.getModel("model-b"), null, "model-b should be evicted (oldest)");
    assert.ok(store.getModel("model-c"), "model-c should survive");
    assert.ok(store.getModel("model-d"), "model-d should exist (just added)");
  });

  it("default maxModels is 2000", () => {
    const store = new CapabilityStore({ logger: silent });
    assert.equal(store._maxModels, 2000);
  });

  it("size getter returns current model count", () => {
    const store = new CapabilityStore({ logger: silent });
    assert.equal(store.size, 0);
    store.ingestFromDiscovery("m1", "p", { contextWindow: 100 });
    assert.equal(store.size, 1);
    store.ingestFromDiscovery("m2", "p", { contextWindow: 200 });
    assert.equal(store.size, 2);
  });
});

// ── Alerter bounded memory ──────────────────────────────────────────────────

describe("Alerter dedup cleanup", () => {
  it("_cleanupExpired removes stale dedup entries", () => {
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 100,
      eventTtls: { test: 100 },
    });
    alerter._send = async () => {};

    // Fire many unique alerts to populate dedup maps
    for (let i = 0; i < 20; i++) {
      alerter.fire("test", { provider: `prov-${i}` });
    }
    assert.equal(alerter.dedupSize, 20);

    // Manually set all entries to be in the past (expired)
    const past = Date.now() - 500; // 500ms ago, well beyond 100ms TTL * 2
    for (const [key] of alerter._lastFired) {
      alerter._lastFired.set(key, past);
    }

    alerter._cleanupExpired();
    assert.equal(alerter.dedupSize, 0, "all expired entries should be cleaned");
    assert.equal(alerter._suppressedCounts.size, 0, "suppressed counts should also be cleaned");

    alerter.destroy();
  });

  it("_cleanupExpired enforces hard cap", () => {
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 0, // no throttle
    });
    alerter._send = async () => {};

    // Directly populate _lastFired with many recent entries
    const now = Date.now();
    for (let i = 0; i < 15000; i++) {
      alerter._lastFired.set(`key-${i}`, now);
    }
    assert.equal(alerter.dedupSize, 15000);

    alerter._cleanupExpired();
    assert.ok(alerter.dedupSize <= 10000, `should be capped at 10000, got ${alerter.dedupSize}`);

    alerter.destroy();
  });

  it("cleans orphaned _suppressedCounts", () => {
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 100,
    });
    alerter._send = async () => {};

    // Manually create orphaned suppressed counts (no matching _lastFired)
    alerter._suppressedCounts.set("orphan:x:y", 5);
    alerter._suppressedCounts.set("orphan:a:b", 3);

    alerter._cleanupExpired();
    assert.equal(alerter._suppressedCounts.size, 0, "orphaned suppressed counts should be cleaned");

    alerter.destroy();
  });

  it("dedupSize getter returns current dedup map size", () => {
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 60000,
    });
    alerter._send = async () => {};

    assert.equal(alerter.dedupSize, 0);
    alerter.fire("test", { provider: "a" });
    assert.equal(alerter.dedupSize, 1);
    alerter.fire("test", { provider: "b" });
    assert.equal(alerter.dedupSize, 2);

    alerter.destroy();
  });

  it("destroy stops cleanup timer", () => {
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
    });
    assert.ok(alerter._cleanupTimer, "cleanup timer should exist");
    alerter.destroy();
    assert.equal(alerter._cleanupTimer, null, "cleanup timer should be null after destroy");
  });
});
