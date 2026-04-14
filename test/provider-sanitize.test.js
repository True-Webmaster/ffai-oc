/**
 * Provider-aware sanitization tests.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitize, PROVIDER_STRIP } = require("../lib/sanitizer");

describe("Provider-aware sanitization", () => {
  it("strips parallel_tool_calls for gemini", () => {
    const body = JSON.stringify({
      model: "gemini-2.0-flash",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: true,
      temperature: 0.7,
    });
    const result = sanitize(body, { provider: "gemini" });
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.parallel_tool_calls, undefined, "parallel_tool_calls should be stripped for gemini");
    assert.equal(parsed.temperature, 0.7, "temperature should remain");
    assert.equal(result.modified, true);
  });

  it("strips logit_bias and logprobs for groq", () => {
    const body = JSON.stringify({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "hi" }],
      logit_bias: { "123": 1 },
      logprobs: true,
      top_logprobs: 5,
    });
    const result = sanitize(body, { provider: "groq" });
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.logit_bias, undefined);
    assert.equal(parsed.logprobs, undefined);
    assert.equal(parsed.top_logprobs, undefined);
    assert.equal(result.modified, true);
  });

  it("falls back to family name for stripping", () => {
    const body = JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: true,
    });
    const result = sanitize(body, { family: "google" });
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.parallel_tool_calls, undefined, "should strip using google family strip set");
  });

  it("does not strip fields for unknown providers", () => {
    const body = JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: true,
      logit_bias: {},
    });
    const result = sanitize(body, { provider: "openai" });
    const parsed = JSON.parse(result.body);
    assert.ok(parsed.parallel_tool_calls !== undefined || parsed.logit_bias !== undefined,
      "unknown providers should keep all allowed fields");
  });

  it("does not strip when no provider specified", () => {
    const body = JSON.stringify({
      model: "test",
      messages: [{ role: "user", content: "hi" }],
      parallel_tool_calls: true,
    });
    const result = sanitize(body);
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.parallel_tool_calls, true, "should keep field when no provider");
  });

  it("PROVIDER_STRIP is exported and has expected providers", () => {
    assert.ok(PROVIDER_STRIP.gemini instanceof Set);
    assert.ok(PROVIDER_STRIP.google instanceof Set);
    assert.ok(PROVIDER_STRIP.groq instanceof Set);
    assert.ok(PROVIDER_STRIP.gemini.has("parallel_tool_calls"));
  });
});
