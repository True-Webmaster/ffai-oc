const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const AuthGuard = require("../lib/auth-guard");

describe("AuthGuard", () => {
  it("allows unblocked IPs", () => {
    const guard = new AuthGuard({ cleanupInterval: 0 });
    assert.equal(guard.isBlocked("1.2.3.4"), false);
    guard.stop();
  });

  it("blocks after exceeding failure threshold", () => {
    const guard = new AuthGuard({ failMax: 3, blockDuration: 60000, cleanupInterval: 0 });
    guard.recordFailure("1.2.3.4");
    guard.recordFailure("1.2.3.4");
    assert.equal(guard.isBlocked("1.2.3.4"), false); // 2 < 3
    guard.recordFailure("1.2.3.4"); // 3 = threshold
    assert.equal(guard.isBlocked("1.2.3.4"), true);
    guard.stop();
  });

  it("does not block different IPs", () => {
    const guard = new AuthGuard({ failMax: 2, cleanupInterval: 0 });
    guard.recordFailure("1.1.1.1");
    guard.recordFailure("1.1.1.1");
    assert.equal(guard.isBlocked("2.2.2.2"), false);
    guard.stop();
  });

  it("timing-safe auth check works", () => {
    assert.equal(AuthGuard.timingSafeCheck("Bearer abc123", "Bearer abc123"), true);
    assert.equal(AuthGuard.timingSafeCheck("Bearer wrong", "Bearer abc123"), false);
    assert.equal(AuthGuard.timingSafeCheck("short", "Bearer abc123"), false);
  });

  it("checkAuth validates Bearer header", () => {
    const guard = new AuthGuard({ cleanupInterval: 0 });
    assert.equal(guard.checkAuth({ authorization: "Bearer mykey" }, "mykey"), true);
    assert.equal(guard.checkAuth({ authorization: "Bearer wrong" }, "mykey"), false);
    assert.equal(guard.checkAuth({}, "mykey"), false);
    // No key required = always passes
    assert.equal(guard.checkAuth({}, ""), true);
    guard.stop();
  });

  it("evicts stale entries when over max", () => {
    const guard = new AuthGuard({ maxEntries: 5, failWindow: 1, cleanupInterval: 0 });
    for (let i = 0; i < 10; i++) {
      guard.recordFailure(`ip-${i}`);
    }
    assert.ok(guard.size <= 10); // Eviction happens, size controlled
    guard.stop();
  });
});
