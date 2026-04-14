/**
 * Thought signature tests — Gemini 3 tool calling support.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Provider = require("../lib/provider");

function makeProvider(overrides = {}) {
  return new Provider("testprov", {
    keys: ["key-aaa-111", "key-bbb-222"],
    rpm_limit: 10,
    tpm_limit: 100000,
    rpd_limit: 1000,
    logger: { log() {}, warn() {}, error() {} },
    ...overrides,
  });
}

describe("Thought Signatures", () => {
  describe("cacheThoughtSignature / getThoughtSignature", () => {
    it("caches and retrieves a signature", () => {
      const prov = makeProvider();
      prov.cacheThoughtSignature("call_123", "sig_abc");
      assert.equal(prov.getThoughtSignature("call_123"), "sig_abc");
    });

    it("returns null for unknown tool call ID", () => {
      const prov = makeProvider();
      assert.equal(prov.getThoughtSignature("nonexistent"), null);
    });

    it("returns null for null/empty inputs", () => {
      const prov = makeProvider();
      assert.equal(prov.getThoughtSignature(null), null);
      assert.equal(prov.getThoughtSignature(""), null);
    });

    it("ignores null/empty when caching", () => {
      const prov = makeProvider();
      prov.cacheThoughtSignature(null, "sig");
      prov.cacheThoughtSignature("id", null);
      prov.cacheThoughtSignature("", "sig");
      assert.equal(prov._thoughtSigCache.size, 0);
    });

    it("evicts oldest entry at capacity", () => {
      const prov = makeProvider();
      prov._thoughtSigMaxSize = 3;
      prov.cacheThoughtSignature("a", "sig_a");
      prov.cacheThoughtSignature("b", "sig_b");
      prov.cacheThoughtSignature("c", "sig_c");
      prov.cacheThoughtSignature("d", "sig_d"); // evicts "a"
      assert.equal(prov.getThoughtSignature("a"), null);
      assert.equal(prov.getThoughtSignature("d"), "sig_d");
      assert.equal(prov._thoughtSigCache.size, 3);
    });

    it("expires entries after TTL", () => {
      const prov = makeProvider();
      prov._thoughtSigTtl = 50; // 50ms TTL
      prov.cacheThoughtSignature("call_1", "sig_1");
      assert.equal(prov.getThoughtSignature("call_1"), "sig_1");

      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 60) {} // busy wait 60ms
      assert.equal(prov.getThoughtSignature("call_1"), null);
    });
  });

  describe("extractThoughtSignatures", () => {
    it("extracts from streaming delta format", () => {
      const prov = makeProvider();
      prov.extractThoughtSignatures({
        choices: [{
          delta: {
            tool_calls: [{
              id: "call_abc123",
              function: { name: "get_weather", arguments: '{"city":"NYC"}' },
              extra_content: { google: { thought_signature: "sig_xyz789" } },
            }],
          },
        }],
      });
      assert.equal(prov.getThoughtSignature("call_abc123"), "sig_xyz789");
    });

    it("extracts from non-streaming message format", () => {
      const prov = makeProvider();
      prov.extractThoughtSignatures({
        choices: [{
          message: {
            tool_calls: [{
              id: "call_msg001",
              function: { name: "search", arguments: '{}' },
              extra_content: { google: { thought_signature: "sig_msg001" } },
            }],
          },
        }],
      });
      assert.equal(prov.getThoughtSignature("call_msg001"), "sig_msg001");
    });

    it("handles multiple tool calls in one response", () => {
      const prov = makeProvider();
      prov.extractThoughtSignatures({
        choices: [{
          message: {
            tool_calls: [
              { id: "tc1", function: { name: "a" }, extra_content: { google: { thought_signature: "s1" } } },
              { id: "tc2", function: { name: "b" }, extra_content: { google: { thought_signature: "s2" } } },
            ],
          },
        }],
      });
      assert.equal(prov.getThoughtSignature("tc1"), "s1");
      assert.equal(prov.getThoughtSignature("tc2"), "s2");
    });

    it("ignores tool_calls without signature", () => {
      const prov = makeProvider();
      prov.extractThoughtSignatures({
        choices: [{ delta: { tool_calls: [{ id: "tc_nosig", function: { name: "x" } }] } }],
      });
      assert.equal(prov.getThoughtSignature("tc_nosig"), null);
    });

    it("ignores invalid/null input", () => {
      const prov = makeProvider();
      prov.extractThoughtSignatures(null);
      prov.extractThoughtSignatures(undefined);
      prov.extractThoughtSignatures({});
      prov.extractThoughtSignatures({ choices: "not an array" });
      assert.equal(prov._thoughtSigCache.size, 0);
    });
  });

  describe("injectThoughtSignatures", () => {
    it("injects cached signatures into tool_calls", () => {
      const prov = makeProvider();
      prov.cacheThoughtSignature("tc1", "cached_sig");

      const messages = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "tc1", function: { name: "test", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tc1", content: "result" },
        { role: "user", content: "thanks" },
      ];

      const modified = prov.injectThoughtSignatures(messages);
      assert.equal(modified, true);
      assert.equal(messages[1].tool_calls[0].extra_content.google.thought_signature, "cached_sig");
      // tool message should remain
      assert.equal(messages[2].role, "tool");
    });

    it("compacts to text when no cached signature available", () => {
      const prov = makeProvider();

      const messages = [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          tool_calls: [{ id: "tc_unknown", function: { name: "get_weather", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "tc_unknown", content: "result" },
        { role: "user", content: "thanks" },
      ];

      const modified = prov.injectThoughtSignatures(messages);
      assert.equal(modified, true);
      // Assistant message should be compacted to text
      assert.equal(messages[1].role, "assistant");
      assert.ok(messages[1].content.includes("get_weather"), `content should mention tool name: ${messages[1].content}`);
      assert.equal(messages[1].tool_calls, undefined);
      // Tool message should be removed
      assert.equal(messages[2].role, "user");
      assert.equal(messages[2].content, "thanks");
      assert.equal(messages.length, 3); // user, assistant(text), user
    });

    it("preserves existing content when compacting", () => {
      const prov = makeProvider();
      const messages = [
        {
          role: "assistant",
          content: "Let me check that.",
          tool_calls: [{ id: "tc_x", function: { name: "search" } }],
        },
        { role: "tool", tool_call_id: "tc_x", content: "found it" },
      ];

      prov.injectThoughtSignatures(messages);
      assert.equal(messages[0].content, "Let me check that.");
      assert.equal(messages.length, 1); // tool message removed
    });

    it("returns false when no modifications needed", () => {
      const prov = makeProvider();
      const messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      assert.equal(prov.injectThoughtSignatures(messages), false);
    });

    it("returns false for null/non-array input", () => {
      const prov = makeProvider();
      assert.equal(prov.injectThoughtSignatures(null), false);
      assert.equal(prov.injectThoughtSignatures("string"), false);
    });

    it("handles mixed: some signatures cached, some not", () => {
      const prov = makeProvider();
      prov.cacheThoughtSignature("tc_cached", "sig_cached");

      const messages = [
        {
          role: "assistant",
          tool_calls: [
            { id: "tc_cached", function: { name: "a", arguments: "{}" } },
            { id: "tc_missing", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "tc_cached", content: "r1" },
        { role: "tool", tool_call_id: "tc_missing", content: "r2" },
      ];

      const modified = prov.injectThoughtSignatures(messages);
      assert.equal(modified, true);
      // Should compact since not ALL have signatures
      assert.ok(!messages[0].tool_calls, "should be compacted to text");
      assert.equal(messages.length, 1); // both tool messages removed
    });

    it("handles multiple assistant+tool rounds", () => {
      const prov = makeProvider();
      prov.cacheThoughtSignature("tc1", "sig1");

      const messages = [
        { role: "user", content: "q1" },
        { role: "assistant", tool_calls: [{ id: "tc1", function: { name: "a" } }] },
        { role: "tool", tool_call_id: "tc1", content: "r1" },
        { role: "user", content: "q2" },
        { role: "assistant", tool_calls: [{ id: "tc2_nocache", function: { name: "b" } }] },
        { role: "tool", tool_call_id: "tc2_nocache", content: "r2" },
      ];

      prov.injectThoughtSignatures(messages);

      // First round: tc1 has cached sig, should be injected (all have sig → keep)
      assert.ok(messages[1].tool_calls, "first assistant msg should keep tool_calls");

      // Second round: tc2_nocache has no sig → compacted
      // After first round: user, assistant(tool_calls), tool, user, assistant(text)
      // The tool message after second assistant should be removed
      const lastAssistant = messages.find((m, i) => i > 2 && m.role === "assistant");
      assert.ok(lastAssistant);
      assert.ok(!lastAssistant.tool_calls, "second assistant should be compacted");
    });
  });
});
