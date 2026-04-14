/**
 * Tests for 6 free-tier-focused features:
 * 1. Free-tier limits database + auto-apply
 * 2. Daily reset clock
 * 3. Provider-specific 429 body parsing
 * 4. Passive-only health inference (verified by absence of probes)
 * 5. Smart queue with soonest-key-available prediction
 * 6. Pre-flight capacity check
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyFreeTierDefaults,
  nextDailyReset,
  msUntilDailyReset,
  isKnownFreeTier,
  getFreeTierLimits,
} = require("../lib/free-tier");
const { parse429 } = require("../lib/error-parser");
const Provider = require("../lib/provider");
const KeyScorer = require("../lib/key-scorer");
const Pool = require("../lib/pool");
const path = require("path");
const os = require("os");

const silentLogger = { log() {}, warn() {}, error() {} };
function tmpStats() {
  return path.join(os.tmpdir(), `ffai-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Free-tier limits database
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 1: Free-tier limits database", () => {
  it("isKnownFreeTier returns true for known providers", () => {
    assert.ok(isKnownFreeTier("gemini"));
    assert.ok(isKnownFreeTier("groq"));
    assert.ok(isKnownFreeTier("openai"));
    assert.ok(isKnownFreeTier("cerebras"));
    assert.ok(isKnownFreeTier("mistral"));
  });

  it("isKnownFreeTier returns false for unknown providers", () => {
    assert.ok(!isKnownFreeTier("unknown-provider"));
    assert.ok(!isKnownFreeTier("deepseek"));
  });

  it("resolves prefix: gemini-flash -> gemini", () => {
    assert.ok(isKnownFreeTier("gemini-flash"));
    assert.ok(isKnownFreeTier("groq-free"));
  });

  it("getFreeTierLimits returns correct defaults", () => {
    const gemini = getFreeTierLimits("gemini");
    assert.ok(gemini);
    assert.equal(gemini.defaults.rpm, 10);
    assert.equal(gemini.defaults.rpd, 250);
    assert.ok(gemini.models["gemini-2.5-pro"]);
  });

  it("applyFreeTierDefaults sets limits when none configured", () => {
    const config = { keys: ["k1"] };
    applyFreeTierDefaults("gemini", config);
    assert.equal(config.rpm_limit, 10);
    assert.equal(config.rpd_limit, 250);
    assert.equal(config.tpm_limit, 250000);
    assert.ok(config.model_limits);
    assert.ok(config.model_limits["gemini-2.5-pro"]);
  });

  it("applyFreeTierDefaults does NOT override explicit limits", () => {
    const config = { keys: ["k1"], rpm_limit: 100, rpd_limit: 5000 };
    applyFreeTierDefaults("gemini", config);
    assert.equal(config.rpm_limit, 100); // kept user's value
    assert.equal(config.rpd_limit, 5000); // kept user's value
  });

  it("Pool auto-applies free-tier defaults", () => {
    const pool = new Pool({
      providers: { gemini: { keys: ["k1"], logger: silentLogger } },
      statsFile: tmpStats(),
      statsFlushInterval: 0,
      logger: silentLogger,
    });
    const prov = pool.getProvider("gemini");
    assert.ok(prov.scorer, "scorer should be enabled via auto-applied limits");
    assert.equal(prov.rpmLimit, 10);
    pool.shutdown();
  });

  it("unknown providers get no defaults", () => {
    const config = { keys: ["k1"] };
    applyFreeTierDefaults("unknown-prov", config);
    assert.ok(!config.rpm_limit);
    assert.ok(!config.rpd_limit);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Daily reset clock
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 2: Daily reset clock", () => {
  it("returns a future timestamp for gemini (has daily reset)", () => {
    const ts = nextDailyReset("gemini");
    assert.ok(ts, "gemini should have a daily reset time");
    assert.ok(ts > Date.now(), "reset should be in the future");
    // Should be within 24 hours
    assert.ok(ts - Date.now() < 86400000 + 1000, "reset should be within 24h");
  });

  it("returns null for rolling providers (groq)", () => {
    const ts = nextDailyReset("groq");
    assert.equal(ts, null, "groq uses rolling windows, no fixed daily reset");
  });

  it("msUntilDailyReset returns positive ms for gemini", () => {
    const ms = msUntilDailyReset("gemini");
    assert.ok(ms > 0, "should have positive ms until reset");
    assert.ok(ms <= 86400000, "should be within 24h");
  });

  it("msUntilDailyReset returns null for rolling providers", () => {
    assert.equal(msUntilDailyReset("groq"), null);
    assert.equal(msUntilDailyReset("openai"), null);
  });

  it("openrouter has daily reset (midnight UTC)", () => {
    const ts = nextDailyReset("openrouter");
    assert.ok(ts, "openrouter should have daily reset");
    assert.ok(ts > Date.now());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Provider-specific 429 body parsing
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 3: Provider-specific 429 parsing", () => {
  it("parses Gemini RESOURCE_EXHAUSTED with quota_metric", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "RATE_LIMIT_EXCEEDED",
          metadata: {
            quota_metric: "generativelanguage.googleapis.com/generate_content_requests",
            quota_limit_value: "5",
          }
        }]
      }
    });
    const result = parse429("gemini", body, {});
    assert.equal(result.quotaMetric, "generativelanguage.googleapis.com/generate_content_requests");
    assert.ok(result.dailyExhausted, "should detect daily request exhaustion");
  });

  it("parses Gemini retryDelay", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "Resource exhausted",
        details: [{ retryDelay: "36s" }]
      }
    });
    const result = parse429("gemini", body, {});
    assert.equal(result.parsedRetryMs, 36000);
  });

  it("parses Groq headers for daily exhaustion", () => {
    const headers = {
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": new Date(Date.now() + 86400000).toISOString(), // tomorrow (dynamic)
    };
    const result = parse429("groq", "", headers);
    assert.ok(result.dailyExhausted, "should detect daily exhaustion from far-future reset");
    assert.ok(result.parsedRetryMs > 0, "should have parsed retry delay");
    assert.equal(result.quotaMetric, "requests");
  });

  it("parses Groq per-minute token reset (short duration)", () => {
    const headers = {
      "x-ratelimit-remaining-requests": "10",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "1.5s",
    };
    const result = parse429("groq", "", headers);
    assert.ok(!result.dailyExhausted, "short reset is per-minute, not daily");
    assert.equal(result.parsedRetryMs, 1500);
    assert.equal(result.quotaMetric, "tokens");
  });

  it("parses OpenAI daily limit from error message", () => {
    const body = JSON.stringify({
      error: {
        type: "rate_limit_exceeded",
        message: "You've exceeded the daily rate limit for this model."
      }
    });
    const result = parse429("openai", body, { "retry-after": "3600" });
    assert.ok(result.dailyExhausted);
    assert.equal(result.parsedRetryMs, 3600000);
  });

  it("parses Cerebras day-level headers", () => {
    const headers = {
      "x-ratelimit-remaining-requests-day": "0",
      "x-ratelimit-reset-requests-day": "3600s",
    };
    const result = parse429("cerebras", "", headers);
    assert.ok(result.dailyExhausted);
    assert.equal(result.parsedRetryMs, 3600000);
    assert.equal(result.quotaMetric, "requests_day");
  });

  it("falls back to generic Retry-After for unknown providers", () => {
    const result = parse429("unknown", "", { "retry-after": "60" });
    assert.equal(result.parsedRetryMs, 60000);
    assert.ok(!result.dailyExhausted);
  });

  it("detects daily exhaustion from very long retry-after (>5min)", () => {
    const result = parse429("unknown", "", { "retry-after": "7200" });
    assert.equal(result.parsedRetryMs, 7200000);
    assert.ok(result.dailyExhausted, "retry-after > 5 min implies daily exhaustion");
  });

  it("handles malformed body gracefully", () => {
    const result = parse429("gemini", "not json at all", {});
    assert.equal(result.parsedRetryMs, 0);
    assert.ok(!result.dailyExhausted);
  });

  it("parses retry-after-ms header", () => {
    const result = parse429("unknown", "", { "retry-after-ms": "1500" });
    assert.equal(result.parsedRetryMs, 1500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Smart queue: soonestAvailableMs
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 5: Smart queue (soonestAvailableMs)", () => {
  it("returns 0 when keys are available", () => {
    const prov = new Provider("test", {
      keys: ["k1", "k2"],
      rpm_limit: 10,
      logger: silentLogger,
    });
    assert.equal(prov.soonestAvailableMs(), 0);
  });

  it("returns cooldown remaining when all keys cooling", () => {
    const prov = new Provider("test", {
      keys: ["k1", "k2"],
      rpm_limit: 10,
      logger: silentLogger,
    });
    const future = Date.now() + 5000;
    prov.cooldowns.set("k1", future);
    prov.cooldowns.set("k2", future + 10000);

    const ms = prov.soonestAvailableMs();
    assert.ok(ms > 0 && ms <= 5100, `should be ~5000ms, got ${ms}`);
  });

  it("returns 0 when at least one key is available", () => {
    const prov = new Provider("test", {
      keys: ["k1", "k2"],
      rpm_limit: 10,
      logger: silentLogger,
    });
    prov.cooldowns.set("k1", Date.now() + 60000);
    // k2 is still available
    assert.equal(prov.soonestAvailableMs(), 0);
  });

  it("considers CB in addition to cooldowns", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      key_cb_threshold: 1,
      key_cb_cooldown: 10000,
      logger: silentLogger,
    });
    // Trip CB via auth failure (bypasses single-key protection)
    const k = prov.acquire();
    prov.release(k, { success: false, statusCode: 401 });

    const ms = prov.soonestAvailableMs();
    assert.ok(ms > 0, "should return positive ms when only key is CB'd");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Pre-flight capacity check
// ═══════════════════════════════════════════════════════════════════════════
describe("Feature 6: Pre-flight capacity check", () => {
  it("returns ok=true when key has plenty of capacity", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      rpm_limit: 10,
      tpm_limit: 100000,
      rpd_limit: 1000,
      logger: silentLogger,
    });
    const k = prov.acquire();
    const check = prov.preflightCheck(k, null, 1000);
    assert.ok(check);
    assert.ok(check.ok, "should have capacity");
    assert.ok(check.rpmRemaining > 0);
    assert.ok(check.tpmRemaining > 0);
    prov.release(k, { success: true });
  });

  it("returns ok=false when RPD is near limit", () => {
    const scorer = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => k,
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 100,
      rpdLimit: 5,
      logger: silentLogger,
    });
    // Use up 5 daily requests
    for (let i = 0; i < 5; i++) scorer.recordRequest("k1", 100);

    const check = scorer.preflightCheck("k1");
    assert.ok(!check.ok, "should be out of daily capacity");
    assert.equal(check.rpdRemaining, 0);
  });

  it("returns ok=false when estimated tokens exceed TPM remaining", () => {
    const scorer = new KeyScorer({
      keys: ["k1", "k2"],
      keyId: k => k,
      getCooldown: () => 0,
      name: "test",
      rpmLimit: 100,
      tpmLimit: 10000,
      logger: silentLogger,
    });
    // Use up most TPM
    scorer.recordRequest("k1", 9000);

    const check = scorer.preflightCheck("k1", null, 5000);
    assert.ok(!check.ok, "should fail — not enough TPM for 5000 tokens");
    assert.ok(check.tpmRemaining < 5000);
  });

  it("returns null when scorer is not active", () => {
    const prov = new Provider("test", {
      keys: ["k1"],
      // No rpm/tpm limits → no scorer
      logger: silentLogger,
    });
    assert.equal(prov.preflightCheck("k1"), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Integration: Daily-reset-aware cooldown
// ═══════════════════════════════════════════════════════════════════════════
describe("Integration: Daily-reset cooldown", () => {
  it("cooldownKey with dailyExhausted uses long cooldown for gemini", () => {
    const prov = new Provider("gemini", {
      keys: ["k1"],
      rpm_limit: 10,
      rpd_limit: 100,
      default_cooldown: 60,
      max_cooldown: 300,
      logger: silentLogger,
    });

    // Cooldown with daily exhaustion context
    prov.cooldownKey("k1", "60", { dailyExhausted: true });

    const cooldownUntil = prov.cooldowns.get("k1");
    const remaining = cooldownUntil - Date.now();

    // Should be much longer than default_cooldown (60s) — should be hours until reset
    assert.ok(remaining > 300000, `daily cooldown should be >5min, got ${remaining}ms`);
  });

  it("cooldownKey with parsedRetryMs uses extracted delay", () => {
    const prov = new Provider("test-prov", {
      keys: ["k1"],
      rpm_limit: 10,
      default_cooldown: 60,
      max_cooldown: 300,
      logger: silentLogger,
    });

    prov.cooldownKey("k1", null, { parsedRetryMs: 5000 });

    const cooldownUntil = prov.cooldowns.get("k1");
    const remaining = cooldownUntil - Date.now();
    // Should use the parsed 5s, not default 60s
    assert.ok(remaining > 3000 && remaining <= 6000, `should be ~5s, got ${remaining}ms`);
  });

  it("cooldownKey without context uses standard logic", () => {
    const prov = new Provider("test-prov", {
      keys: ["k1"],
      rpm_limit: 10,
      default_cooldown: 30,
      max_cooldown: 300,
      logger: silentLogger,
    });

    prov.cooldownKey("k1", "10");

    const cooldownUntil = prov.cooldowns.get("k1");
    const remaining = cooldownUntil - Date.now();
    assert.ok(remaining > 8000 && remaining <= 11000, `should be ~10s, got ${remaining}ms`);
  });
});
