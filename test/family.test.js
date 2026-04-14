const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Pool = require("../lib/pool");
const path = require("path");
const os = require("os");

function tmpStatsFile() {
  return path.join(os.tmpdir(), `ffai-test-stats-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const silent = { log() {}, warn() {}, error() {} };

/**
 * Helper: build a pool with multiple providers optionally grouped by family.
 * @param {Object.<string, object>} providers - Provider configs keyed by name
 */
function makePool(providers) {
  return new Pool({
    providers,
    statsFile: tmpStatsFile(),
    statsFlushInterval: 0,
    logger: silent,
  });
}

describe("Provider Family Labels", () => {

  describe("families()", () => {
    it("returns correct grouping when families are configured", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1", "g2"] },
        "gemini-flash": { family: "google", keys: ["gf1"] },
        groq: { family: "groq", keys: ["q1", "q2"] },
      });

      const fam = pool.families();
      assert.deepEqual(fam.google.sort(), ["gemini", "gemini-flash"]);
      assert.deepEqual(fam.groq, ["groq"]);
      assert.equal(Object.keys(fam).length, 2);
      pool.shutdown();
    });
  });

  describe("acquireFromFamily()", () => {
    it("returns a key from an available provider in the family", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1", "g2"] },
        "gemini-flash": { family: "google", keys: ["gf1"] },
      });

      const handle = pool.acquireFromFamily("google");
      assert.ok(handle, "should return a handle");
      assert.ok(["gemini", "gemini-flash"].includes(handle.provider));
      assert.equal(handle.family, "google");
      assert.ok(handle.key);
      pool.shutdown();
    });

    it("prefers provider with more available keys", () => {
      // gemini has 5 keys, gemini-flash has 1 key
      // acquireFromFamily should prefer gemini (more capacity)
      const pool = makePool({
        "gemini-flash": { family: "google", keys: ["gf1"] },
        gemini: { family: "google", keys: ["g1", "g2", "g3", "g4", "g5"] },
      });

      // Acquire several times — first should come from gemini (5 available vs 1)
      const handle = pool.acquireFromFamily("google");
      assert.ok(handle);
      assert.equal(handle.provider, "gemini", "should prefer provider with more available keys");
      pool.shutdown();
    });

    it("falls back to other providers in family when first is exhausted", () => {
      // Use 401 to hard-break the key (bypasses percentage-based cooldown)
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000 },
        "gemini-flash": { family: "google", keys: ["gf1"] },
      });

      // Exhaust gemini by triggering auth hard-break (401 always breaks immediately)
      const h1 = pool.acquire("gemini");
      assert.ok(h1);
      pool.release("gemini", h1.key, { success: false, statusCode: 401 });

      // Now acquireFromFamily should get from gemini-flash
      const handle = pool.acquireFromFamily("google");
      assert.ok(handle, "should still get a key from the family");
      assert.equal(handle.provider, "gemini-flash");
      assert.equal(handle.family, "google");
      pool.shutdown();
    });

    it("returns null when all providers in family are exhausted", () => {
      // Use 401 to hard-break keys (bypasses percentage-based cooldown)
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000 },
        "gemini-flash": { family: "google", keys: ["gf1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000 },
      });

      // Exhaust both providers with auth failures
      const h1 = pool.acquire("gemini");
      pool.release("gemini", h1.key, { success: false, statusCode: 401 });

      const h2 = pool.acquire("gemini-flash");
      pool.release("gemini-flash", h2.key, { success: false, statusCode: 401 });

      const handle = pool.acquireFromFamily("google");
      assert.equal(handle, null, "should return null when all providers exhausted");
      pool.shutdown();
    });

    it("returns null for unknown family", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"] },
      });

      const handle = pool.acquireFromFamily("nonexistent");
      assert.equal(handle, null);
      pool.shutdown();
    });
  });

  describe("auto-family for providers without family config", () => {
    it("assigns provider name as singleton family when no family configured", () => {
      const pool = makePool({
        gemini: { keys: ["g1", "g2"] },
        groq: { keys: ["q1"] },
      });

      const fam = pool.families();
      assert.deepEqual(fam.gemini, ["gemini"]);
      assert.deepEqual(fam.groq, ["groq"]);
      assert.equal(Object.keys(fam).length, 2);
      pool.shutdown();
    });

    it("acquireFromFamily works with auto-family name", () => {
      const pool = makePool({
        gemini: { keys: ["g1"] },
      });

      const handle = pool.acquireFromFamily("gemini");
      assert.ok(handle);
      assert.equal(handle.provider, "gemini");
      assert.equal(handle.family, "gemini");
      pool.shutdown();
    });
  });

  describe("mixed family and non-family providers", () => {
    it("handles mix of explicit families and auto-families", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"] },
        "gemini-flash": { family: "google", keys: ["gf1"] },
        groq: { keys: ["q1"] }, // no family → auto-family "groq"
      });

      const fam = pool.families();
      assert.deepEqual(fam.google.sort(), ["gemini", "gemini-flash"]);
      assert.deepEqual(fam.groq, ["groq"]);
      assert.equal(Object.keys(fam).length, 2);
      pool.shutdown();
    });
  });

  describe("providerFamily()", () => {
    it("returns the family name for a provider", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"] },
        groq: { keys: ["q1"] },
      });

      assert.equal(pool.providerFamily("gemini"), "google");
      assert.equal(pool.providerFamily("groq"), "groq");
      assert.equal(pool.providerFamily("nonexistent"), undefined);
      pool.shutdown();
    });
  });

  describe("health() includes family rollup", () => {
    it("includes families section in health output", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1", "g2"] },
        "gemini-flash": { family: "google", keys: ["gf1"] },
        groq: { keys: ["q1"] },
      });

      const h = pool.health();
      assert.ok(h.families, "health should include families");
      assert.ok(h.families.google, "should have google family");
      assert.ok(h.families.groq, "should have groq family");

      // Google family rollup
      assert.equal(h.families.google.status, "ok");
      assert.deepEqual(h.families.google.providers.sort(), ["gemini", "gemini-flash"]);
      assert.equal(h.families.google.keys.total, 3); // 2 + 1
      assert.equal(h.families.google.keys.available, 3);

      // Groq family rollup
      assert.equal(h.families.groq.status, "ok");
      assert.deepEqual(h.families.groq.providers, ["groq"]);
      assert.equal(h.families.groq.keys.total, 1);
      assert.equal(h.families.groq.keys.available, 1);

      pool.shutdown();
    });

    it("reports family as degraded when all members are degraded", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000 },
      });

      // Trip the per-key circuit breaker with auth failure (bypasses single-key protection)
      const h1 = pool.acquire("gemini");
      pool.release("gemini", h1.key, { success: false, statusCode: 401 });

      const h = pool.health();
      assert.equal(h.families.google.status, "degraded");
      assert.equal(h.families.google.keys.available, 0);
      pool.shutdown();
    });

    it("reports family as ok when at least one member is ok", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"], rpm_limit: 10, key_cb_threshold: 1, key_cb_cooldown: 60000 },
        "gemini-flash": { family: "google", keys: ["gf1"] },
      });

      // Trip gemini but leave gemini-flash ok
      const h1 = pool.acquire("gemini");
      pool.release("gemini", h1.key, { success: false, statusCode: 500 });

      const h = pool.health();
      assert.equal(h.families.google.status, "ok");
      pool.shutdown();
    });

    it("each provider entry includes its family name", () => {
      const pool = makePool({
        gemini: { family: "google", keys: ["g1"] },
        groq: { keys: ["q1"] },
      });

      const h = pool.health();
      assert.equal(h.providers.gemini.family, "google");
      assert.equal(h.providers.groq.family, "groq");
      pool.shutdown();
    });
  });
});
