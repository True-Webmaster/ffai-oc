/**
 * Pool reload + cost tracking tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Pool = require("../lib/pool");
const path = require("node:path");
const os = require("node:os");

function tmpStats() {
  return path.join(os.tmpdir(), `ffai-reload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const silent = { log() {}, warn() {}, error() {} };

describe("Pool.reload()", () => {
  it("adds new providers on reload", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });
    assert.equal(pool.size, 1);

    pool.reload({
      prov1: { keys: ["k1"], logger: silent },
      prov2: { keys: ["k2"], logger: silent },
    });
    assert.equal(pool.size, 2);
    assert.ok(pool.getProvider("prov2"));
    pool.shutdown();
  });

  it("removes providers that are no longer in config", () => {
    const pool = new Pool({
      providers: {
        prov1: { keys: ["k1"], logger: silent },
        prov2: { keys: ["k2"], logger: silent },
      },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });
    assert.equal(pool.size, 2);

    pool.reload({ prov1: { keys: ["k1"], logger: silent } });
    assert.equal(pool.size, 1);
    assert.equal(pool.getProvider("prov2"), undefined);
    pool.shutdown();
  });

  it("preserves state when keys unchanged", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1", "k2"], rpm_limit: 10, logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    // Acquire to change state
    const handle = pool.acquire("prov1");
    assert.ok(handle);
    pool.release("prov1", handle.key, { success: true });

    const provBefore = pool.getProvider("prov1");
    pool.reload({ prov1: { keys: ["k1", "k2"], rpm_limit: 10, logger: silent } });
    const provAfter = pool.getProvider("prov1");

    assert.strictEqual(provBefore, provAfter, "same instance should be reused when keys unchanged");
    pool.shutdown();
  });

  it("rebuilds provider when keys change", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    const provBefore = pool.getProvider("prov1");
    pool.reload({ prov1: { keys: ["k1", "k2_new"], logger: silent } });
    const provAfter = pool.getProvider("prov1");

    assert.notStrictEqual(provBefore, provAfter, "should be new instance when keys changed");
    assert.equal(provAfter.keys.length, 2);
    pool.shutdown();
  });

  it("rebuilds family map on reload", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], family: "fam1", logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    pool.reload({
      prov1: { keys: ["k1"], family: "fam_new", logger: silent },
      prov2: { keys: ["k2"], family: "fam_new", logger: silent },
    });

    const families = pool.families();
    assert.ok(families.fam_new);
    assert.equal(families.fam_new.length, 2);
    assert.equal(families.fam1, undefined);
    pool.shutdown();
  });
});

describe("Cost tracking in stats", () => {
  it("records token usage and estimated cost via release", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], rpm_limit: 10, logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
      pricing: { prov1: 0.005, default: 0.01 },
    });

    const handle = pool.acquire("prov1");
    pool.release("prov1", handle.key, {
      success: true,
      inputTokens: 500,
      outputTokens: 200,
    });

    const stats = pool.stats.toJSON();
    const today = new Date().toISOString().slice(0, 10);
    const dayData = stats.days[today]?.providers?.prov1;

    assert.ok(dayData, "should have stats for today");
    assert.ok(dayData.tokens, "should have token tracking");
    assert.equal(dayData.tokens.input, 500);
    assert.equal(dayData.tokens.output, 200);
    assert.equal(dayData.estimatedCost, 0.005);
    pool.shutdown();
  });

  it("uses default pricing when provider not in pricing map", () => {
    const pool = new Pool({
      providers: { unknown_prov: { keys: ["k1"], rpm_limit: 10, logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
      pricing: { default: 0.002 },
    });

    const handle = pool.acquire("unknown_prov");
    pool.release("unknown_prov", handle.key, { success: true, inputTokens: 100 });

    const stats = pool.stats.toJSON();
    const today = new Date().toISOString().slice(0, 10);
    const dayData = stats.days[today]?.providers?.unknown_prov;

    assert.equal(dayData.estimatedCost, 0.002);
    pool.shutdown();
  });

  it("accumulates cost across multiple requests", () => {
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], rpm_limit: 100, logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
      pricing: { prov1: 0.01 },
    });

    for (let i = 0; i < 5; i++) {
      const handle = pool.acquire("prov1");
      pool.release("prov1", handle.key, { success: true, inputTokens: 100 });
    }

    const stats = pool.stats.toJSON();
    const today = new Date().toISOString().slice(0, 10);
    const dayData = stats.days[today]?.providers?.prov1;

    assert.equal(dayData.tokens.input, 500);
    assert.ok(Math.abs(dayData.estimatedCost - 0.05) < 0.0001, `cost should be ~0.05, got ${dayData.estimatedCost}`);
    pool.shutdown();
  });
});

describe("Alerter integration with Pool", () => {
  it("fires alert on all_keys_exhausted", () => {
    const fired = [];
    const pool = new Pool({
      providers: { prov1: { keys: ["k1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000, logger: silent } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silent,
    });

    // Mock the alerter
    pool.alerter.fire = (event, payload) => { fired.push({ event, payload }); };

    // Trigger circuit break with auth failure (bypasses single-key protection)
    const handle = pool.acquire("prov1");
    pool.release("prov1", handle.key, { success: false, statusCode: 401 });

    // Now all keys are CB'd, next acquire should fire alert
    const handle2 = pool.acquire("prov1");
    assert.equal(handle2, null);
    assert.ok(fired.some(f => f.event === "circuit_open" || f.event === "all_keys_exhausted"),
      "should fire an alert event");
    pool.shutdown();
  });
});
