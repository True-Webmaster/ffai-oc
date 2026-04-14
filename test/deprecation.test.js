const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const DeprecationTracker = require("../lib/deprecation-tracker");

const silentLogger = { log() {}, warn() {}, error() {} };

function makeTracker() {
  return new DeprecationTracker({ logger: silentLogger });
}

describe("DeprecationTracker", () => {
  it("404 with 'no longer available' marks model as deprecated", () => {
    const dt = makeTracker();
    const result = dt.check(404, '{"error":"This model is no longer available"}', "gpt-3.5-turbo", "openai");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("gpt-3.5-turbo"), true);
  });

  it("404 with exact Gemini deprecation message detected", () => {
    const dt = makeTracker();
    const body = '{"error":{"message":"This model models/gemini-2.0-flash is no longer available","code":404}}';
    const result = dt.check(404, body, "gemini-2.0-flash", "gemini");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("gemini-2.0-flash"), true);
  });

  it("400 with 'model not found' marks as deprecated", () => {
    const dt = makeTracker();
    const result = dt.check(400, '{"error":"The model not found in our system"}', "old-model", "provider-a");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("old-model"), true);
  });

  it("400 with 'invalid model' marks as deprecated", () => {
    const dt = makeTracker();
    const result = dt.check(400, '{"error":"Invalid model specified"}', "bad-model", "provider-b");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("bad-model"), true);
  });

  it("404 without deprecation keywords does NOT mark", () => {
    const dt = makeTracker();
    const result = dt.check(404, '{"error":"endpoint not found"}', "some-model", "prov");
    // "not found" IS in the keyword list, so let's use a body without any keywords
    // Actually "not found" is a keyword — let's test with a truly non-matching body
    const result2 = dt.check(404, '{"error":"permission denied"}', "other-model", "prov");
    assert.equal(result2, false);
    assert.equal(dt.isDeprecated("other-model"), false);
  });

  it("404 with unrelated error body does NOT mark as deprecated", () => {
    const dt = makeTracker();
    const result = dt.check(404, '{"error":"resource unavailable, try again later"}', "some-model", "prov");
    assert.equal(result, false);
    assert.equal(dt.isDeprecated("some-model"), false);
  });

  it("isDeprecated() returns true for known deprecated models", () => {
    const dt = makeTracker();
    assert.equal(dt.isDeprecated("unknown-model"), false);
    dt.check(404, "deprecated model", "old-model", "prov");
    assert.equal(dt.isDeprecated("old-model"), true);
    assert.equal(dt.isDeprecated("unknown-model"), false);
  });

  it("getAll() returns all deprecated models", () => {
    const dt = makeTracker();
    dt.check(404, "model is no longer available", "model-a", "prov-1");
    dt.check(400, "model not found", "model-b", "prov-2");

    const all = dt.getAll();
    assert.ok(all["model-a"]);
    assert.equal(all["model-a"].provider, "prov-1");
    assert.ok(all["model-a"].detectedAt > 0);
    assert.ok(all["model-b"]);
    assert.equal(all["model-b"].provider, "prov-2");
    // Should only have 2 entries
    assert.equal(Object.keys(all).length, 2);
  });

  it("double-detection doesn't duplicate", () => {
    const dt = makeTracker();
    const warnings = [];
    const trackLogger = { log() {}, warn(msg) { warnings.push(msg); }, error() {} };
    const dt2 = new DeprecationTracker({ logger: trackLogger });

    dt2.check(404, "model deprecated", "model-x", "prov");
    dt2.check(404, "model deprecated again", "model-x", "prov");

    // Should only have logged one warning
    assert.equal(warnings.length, 1);
    // getAll should still have one entry
    assert.equal(Object.keys(dt2.getAll()).length, 1);
  });

  it("check() returns true for deprecated (signals caller not to count as key error)", () => {
    const dt = makeTracker();

    // First detection returns true
    const first = dt.check(404, "model has been removed", "rm-model", "prov");
    assert.equal(first, true);

    // Second detection also returns true (already known)
    const second = dt.check(404, "model has been removed", "rm-model", "prov");
    assert.equal(second, true);
  });

  it("returns false when model is null or empty", () => {
    const dt = makeTracker();
    assert.equal(dt.check(404, "model deprecated", null, "prov"), false);
    assert.equal(dt.check(404, "model deprecated", "", "prov"), false);
  });

  it("detects 'decommissioned' keyword", () => {
    const dt = makeTracker();
    const result = dt.check(404, '{"error":"This model has been decommissioned"}', "old-v1", "prov");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("old-v1"), true);
  });

  it("detects 'sunset' keyword", () => {
    const dt = makeTracker();
    const result = dt.check(404, '{"error":"This model was sunset on 2024-01-01"}', "sunset-model", "prov");
    assert.equal(result, true);
    assert.equal(dt.isDeprecated("sunset-model"), true);
  });

  it("does not trigger on non-400/404 status codes", () => {
    const dt = makeTracker();
    assert.equal(dt.check(500, "model deprecated", "model-x", "prov"), false);
    assert.equal(dt.check(429, "model not found", "model-y", "prov"), false);
    assert.equal(dt.check(200, "model deprecated", "model-z", "prov"), false);
  });

  it("truncates long response bodies in stored message", () => {
    const dt = makeTracker();
    const longBody = "model deprecated " + "x".repeat(300);
    dt.check(404, longBody, "long-model", "prov");
    const all = dt.getAll();
    assert.ok(all["long-model"].message.length <= 203); // 200 + "..."
    assert.ok(all["long-model"].message.endsWith("..."));
  });
});
