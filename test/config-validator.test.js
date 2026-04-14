/**
 * Tests for ConfigValidator — config.json schema validation.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../lib/config-validator");

const validProvider = {
  upstream_url: "https://api.example.com/v1",
  keys_var: "TEST_KEYS",
  auth_scheme: "bearer",
  rpm_limit: 15,
  retryable_statuses: [429, 502, 503],
};

function makeConfig(overrides = {}) {
  return {
    providers: { test: { ...validProvider, ...overrides } },
  };
}

describe("ConfigValidator", () => {
  it("accepts valid config", () => {
    const env = { TEST_KEYS: "key1,key2" };
    const { errors, warnings } = validateConfig(makeConfig(), env);
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it("rejects null config", () => {
    const { errors } = validateConfig(null);
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("non-null object"));
  });

  it("rejects missing providers", () => {
    const { errors } = validateConfig({});
    assert.ok(errors.length > 0);
    assert.ok(errors[0].includes("providers"));
  });

  it("warns on empty providers", () => {
    const { errors, warnings } = validateConfig({ providers: {} });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(w => w.includes("empty")));
  });

  it("rejects missing upstream_url", () => {
    const { errors } = validateConfig({
      providers: { test: { keys_var: "X" } },
    }, { X: "key1" });
    assert.ok(errors.some(e => e.includes("upstream_url")));
  });

  it("rejects invalid upstream_url", () => {
    const { errors } = validateConfig({
      providers: { test: { upstream_url: "not-a-url", keys_var: "X" } },
    }, { X: "key1" });
    assert.ok(errors.some(e => e.includes("not a valid URL")));
  });

  it("rejects missing keys and keys_var", () => {
    const { errors } = validateConfig({
      providers: { test: { upstream_url: "https://api.example.com" } },
    });
    assert.ok(errors.some(e => e.includes("keys")));
  });

  it("warns on empty keys_var env", () => {
    const { errors, warnings } = validateConfig(makeConfig(), {});
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(w => w.includes("empty or not set")));
  });

  it("rejects invalid auth_scheme", () => {
    const { errors } = validateConfig(makeConfig({ auth_scheme: "magic" }), { TEST_KEYS: "k1" });
    assert.ok(errors.some(e => e.includes("auth_scheme")));
  });

  it("rejects header auth without auth_header", () => {
    const { errors } = validateConfig(makeConfig({ auth_scheme: "header" }), { TEST_KEYS: "k1" });
    assert.ok(errors.some(e => e.includes("auth_header")));
  });

  it("rejects negative numeric fields", () => {
    const { errors } = validateConfig(makeConfig({ rpm_limit: -5 }), { TEST_KEYS: "k1" });
    assert.ok(errors.some(e => e.includes("rpm_limit") && e.includes("non-negative")));
  });

  it("rejects non-number numeric fields", () => {
    const { errors } = validateConfig(makeConfig({ rpm_limit: "fast" }), { TEST_KEYS: "k1" });
    assert.ok(errors.some(e => e.includes("rpm_limit") && e.includes("expected number")));
  });

  it("warns on cooldown mismatch", () => {
    const { warnings } = validateConfig(
      makeConfig({ default_cooldown: 300, max_cooldown: 60 }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(warnings.some(w => w.includes("max_cooldown")));
  });

  it("warns on very high acquire_wait_ms", () => {
    const { warnings } = validateConfig(
      makeConfig({ acquire_wait_ms: 120000 }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(warnings.some(w => w.includes("acquire_wait_ms")));
  });

  it("validates retryable_statuses is array", () => {
    const { errors } = validateConfig(
      makeConfig({ retryable_statuses: "429" }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(errors.some(e => e.includes("retryable_statuses")));
  });

  it("warns on invalid status codes", () => {
    const { warnings } = validateConfig(
      makeConfig({ retryable_statuses: [429, 999] }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(warnings.some(w => w.includes("999")));
  });

  it("validates pricing if present", () => {
    const config = makeConfig();
    config.pricing = { gemini: -1 };
    const { warnings } = validateConfig(config, { TEST_KEYS: "k1" });
    assert.ok(warnings.some(w => w.includes("pricing")));
  });

  it("accepts inline keys array", () => {
    const { errors } = validateConfig({
      providers: {
        test: {
          upstream_url: "https://api.example.com",
          keys: ["key1", "key2"],
        },
      },
    });
    assert.equal(errors.length, 0);
  });

  it("validates models is array", () => {
    const { errors } = validateConfig(
      makeConfig({ models: "not-an-array" }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(errors.some(e => e.includes("models")));
  });

  it("validates model_limits is object", () => {
    const { errors } = validateConfig(
      makeConfig({ model_limits: "not-object" }),
      { TEST_KEYS: "k1" },
    );
    assert.ok(errors.some(e => e.includes("model_limits")));
  });
});
