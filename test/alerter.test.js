/**
 * Alerter tests — throttled webhook notifications.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Alerter = require("../lib/alerter");

describe("Alerter", () => {
  it("does nothing when no webhookUrl is configured", () => {
    const alerter = new Alerter();
    assert.equal(alerter.enabled, false);
    // Should not throw
    alerter.fire("test_event", { message: "hello" });
  });

  it("reports enabled when webhookUrl is set", () => {
    const alerter = new Alerter({ webhookUrl: "http://localhost:9999/hook" });
    assert.equal(alerter.enabled, true);
  });

  it("throttles duplicate events within throttle window", () => {
    let callCount = 0;
    const alerter = new Alerter({
      webhookUrl: "http://localhost:9999/hook",
      throttleMs: 60000,
    });
    // Mock _send to count calls
    alerter._send = async () => { callCount++; };

    alerter.fire("circuit_open", { provider: "gemini" });
    alerter.fire("circuit_open", { provider: "gemini" }); // throttled
    alerter.fire("circuit_open", { provider: "gemini" }); // throttled
    assert.equal(callCount, 1, "should only fire once within throttle window");
  });

  it("allows different event types through independently", () => {
    let callCount = 0;
    const alerter = new Alerter({ webhookUrl: "http://localhost:9999/hook", throttleMs: 60000 });
    alerter._send = async () => { callCount++; };

    alerter.fire("circuit_open", {});
    alerter.fire("all_keys_exhausted", {});
    assert.equal(callCount, 2, "different event types should not throttle each other");
  });

  it("sends correct JSON payload to webhook", async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200);
        res.end();
      });
    });

    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    const alerter = new Alerter({
      webhookUrl: `http://127.0.0.1:${port}/hook`,
      throttleMs: 0, // no throttle for test
    });

    alerter.fire("circuit_open", { provider: "gemini", message: "test" });

    // Wait for async send
    await new Promise(r => setTimeout(r, 200));

    assert.equal(received.length, 1);
    assert.equal(received[0].event, "circuit_open");
    assert.equal(received[0].provider, "gemini");
    assert.ok(received[0].timestamp, "should have timestamp");

    server.close();
  });

  it("handles webhook errors gracefully", async () => {
    const errors = [];
    const alerter = new Alerter({
      webhookUrl: "http://127.0.0.1:1/nonexistent",
      throttleMs: 0,
      logger: { log() {}, warn() {}, error(msg) { errors.push(msg); } },
    });

    alerter.fire("test", {});
    await new Promise(r => setTimeout(r, 500));
    assert.ok(errors.length > 0, "should log error on connection failure");
  });
});
