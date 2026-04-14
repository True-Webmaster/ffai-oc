const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitize, withRetry } = require("../lib/sanitizer");

describe("sanitize", () => {
  it("strips non-standard fields", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      custom_field: true,
      another_bad: "drop me",
    });
    const result = sanitize(body);
    assert.equal(result.modified, true);
    assert.ok(!result.parsed.custom_field);
    assert.ok(!result.parsed.another_bad);
    assert.equal(result.parsed.model, "gpt-4");
  });

  it("normalizes max_completion_tokens to max_tokens", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [],
      max_completion_tokens: 4096,
    });
    const result = sanitize(body);
    assert.equal(result.modified, true);
    assert.equal(result.parsed.max_tokens, 4096);
    assert.equal(result.parsed.max_completion_tokens, undefined);
  });

  it("caps max_tokens when maxOutputTokens configured", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [],
      max_tokens: 100000,
    });
    const result = sanitize(body, { maxOutputTokens: 8192 });
    assert.equal(result.modified, true);
    assert.equal(result.parsed.max_tokens, 8192);
  });

  it("passes through clean bodies unmodified", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    const result = sanitize(body);
    assert.equal(result.modified, false);
  });

  it("handles invalid JSON gracefully", () => {
    const result = sanitize("not json");
    assert.equal(result.modified, false);
    assert.equal(result.parsed, null);
  });

  it("removes stream_options when not streaming", () => {
    const body = JSON.stringify({
      model: "gpt-4",
      messages: [],
      stream_options: { include_usage: true },
    });
    const result = sanitize(body);
    assert.equal(result.modified, true);
    assert.equal(result.parsed.stream_options, undefined);
  });
});

describe("withRetry", () => {
  it("returns on first success", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries on failure", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    }, { maxRetries: 3, baseDelay: 1 });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  it("throws after max retries", async () => {
    await assert.rejects(
      () => withRetry(async () => { throw new Error("always fails"); }, { maxRetries: 2, baseDelay: 1 }),
      { message: "always fails" }
    );
  });

  it("respects shouldRetry predicate", async () => {
    let calls = 0;
    await assert.rejects(
      () => withRetry(
        async () => { calls++; throw new Error("stop"); },
        { maxRetries: 5, baseDelay: 1, shouldRetry: () => false }
      ),
      { message: "stop" }
    );
    assert.equal(calls, 1); // No retries
  });

  it("calls onRetry callback", async () => {
    const retries = [];
    await withRetry(
      async (attempt) => { if (attempt < 2) throw new Error("fail"); return "ok"; },
      { maxRetries: 3, baseDelay: 1, onRetry: (err, attempt, delay) => retries.push({ attempt, delay }) }
    );
    assert.equal(retries.length, 2);
    assert.equal(retries[0].attempt, 0);
  });
});
