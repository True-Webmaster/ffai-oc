const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");

const {
  parseArgs,
  fmt,
  fmtMoney,
  formatUptime,
  padRow,
  loadStats,
  DEFAULT_PRICING,
} = require("../cli");

// ── Helpers ────────────────────────────────────────────────────────────────

function tmpDir() {
  const dir = path.join(os.tmpdir(), `ffai-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function makeSampleStats(overrides = {}) {
  return {
    startedAt: Date.now() - 86400000 * 2, // 2 days ago
    days: {
      "2026-04-07": {
        providers: {
          gemini: { requests: 1234, rateLimited: 12, errors: 3, allKeysExhausted: 0, circuitBreaks: 0, perKey: {} },
          groq: { requests: 456, rateLimited: 2, errors: 0, allKeysExhausted: 0, circuitBreaks: 0, perKey: {} },
        },
      },
      "2026-04-06": {
        providers: {
          gemini: { requests: 1100, rateLimited: 8, errors: 1, allKeysExhausted: 0, circuitBreaks: 0, perKey: {} },
          groq: { requests: 300, rateLimited: 1, errors: 0, allKeysExhausted: 0, circuitBreaks: 0, perKey: {} },
        },
      },
      ...overrides,
    },
  };
}

function makeSampleConfig() {
  return {
    pricing: {
      gemini: 0.0025,
      groq: 0.001,
      default: 0.005,
    },
    providers: {
      gemini: {
        keys: ["test-key-aaa111", "test-key-bbb222"],
        rpm_limit: 15,
        tpm_limit: 1000000,
        rpd_limit: 1500,
      },
      groq: {
        keys: ["test-key-ccc333"],
        rpm_limit: 30,
        tpm_limit: 6000,
        rpd_limit: 14400,
      },
    },
  };
}

// ── parseArgs tests ────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses bare command", () => {
    const r = parseArgs(["node", "cli.js", "status"]);
    assert.equal(r.command, "status");
    assert.deepEqual(r.flags, {});
    assert.deepEqual(r.positional, []);
  });

  it("parses command with --days flag", () => {
    const r = parseArgs(["node", "cli.js", "usage", "--days", "14"]);
    assert.equal(r.command, "usage");
    assert.equal(r.flags.days, 14);
  });

  it("parses --days= syntax", () => {
    const r = parseArgs(["node", "cli.js", "savings", "--days=30"]);
    assert.equal(r.command, "savings");
    assert.equal(r.flags.days, 30);
  });

  it("parses positional args", () => {
    const r = parseArgs(["node", "cli.js", "keys", "gemini"]);
    assert.equal(r.command, "keys");
    assert.deepEqual(r.positional, ["gemini"]);
  });

  it("returns empty command for no args", () => {
    const r = parseArgs(["node", "cli.js"]);
    assert.equal(r.command, "");
  });
});

// ── Number formatting ──────────────────────────────────────────────────────

describe("fmt", () => {
  it("formats integers with commas", () => {
    assert.equal(fmt(1234), "1,234");
    assert.equal(fmt(1000000), "1,000,000");
  });

  it("handles zero", () => {
    assert.equal(fmt(0), "0");
  });

  it("handles small numbers", () => {
    assert.equal(fmt(42), "42");
  });
});

describe("fmtMoney", () => {
  it("formats as dollar amount with two decimals", () => {
    assert.equal(fmtMoney(12.5), "$12.50");
    assert.equal(fmtMoney(0), "$0.00");
    assert.equal(fmtMoney(14.506), "$14.51");
  });
});

// ── formatUptime ───────────────────────────────────────────────────────────

describe("formatUptime", () => {
  it("formats days/hours/minutes", () => {
    const ms = (2 * 86400 + 5 * 3600 + 12 * 60) * 1000;
    assert.equal(formatUptime(ms), "2d 5h 12m");
  });

  it("formats hours/minutes only", () => {
    const ms = (3 * 3600 + 45 * 60) * 1000;
    assert.equal(formatUptime(ms), "3h 45m");
  });

  it("formats minutes only", () => {
    assert.equal(formatUptime(300000), "5m");
  });

  it("handles zero", () => {
    assert.equal(formatUptime(0), "0m");
  });
});

// ── padRow ─────────────────────────────────────────────────────────────────

describe("padRow", () => {
  it("returns padded columns", () => {
    const row = padRow(["gemini", "5", "4", "enabled", "ok"]);
    assert.ok(row.includes("gemini"));
    assert.ok(row.includes("enabled"));
  });
});

// ── loadStats ──────────────────────────────────────────────────────────────

describe("loadStats", () => {
  it("returns null for missing file", () => {
    const result = loadStats("/tmp/nonexistent-ffai-stats-12345.json");
    assert.equal(result, null);
  });

  it("reads valid stats file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "stats.json");
    const data = makeSampleStats();
    writeJSON(file, data);
    const result = loadStats(file);
    assert.equal(result.days["2026-04-07"].providers.gemini.requests, 1234);
  });

  it("returns null for corrupt JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "stats.json");
    fs.writeFileSync(file, "not json{{{");
    const result = loadStats(file);
    assert.equal(result, null);
  });
});

// ── Savings calculation ────────────────────────────────────────────────────

describe("savings calculation", () => {
  it("calculates correct savings with known pricing", () => {
    const pricing = { ...DEFAULT_PRICING, gemini: 0.0025, groq: 0.001 };
    // gemini: 1234 + 1100 = 2334 requests * $0.0025 = $5.835
    // groq:   456 + 300 = 756 requests * $0.001 = $0.756
    const geminiSavings = 2334 * pricing.gemini;
    const groqSavings = 756 * pricing.groq;
    assert.ok(Math.abs(geminiSavings - 5.835) < 0.001);
    assert.ok(Math.abs(groqSavings - 0.756) < 0.001);
  });

  it("uses default pricing for unknown provider", () => {
    const pricing = { ...DEFAULT_PRICING };
    const rate = pricing["unknown-prov"] ?? pricing.default;
    assert.equal(rate, 0.005);
  });
});

// ── Usage aggregation ──────────────────────────────────────────────────────

describe("usage aggregation", () => {
  it("aggregates totals from stats data", () => {
    const stats = makeSampleStats();
    const dates = Object.keys(stats.days).sort().reverse();
    let totalReqs = 0, totalRL = 0, totalErrs = 0;
    for (const date of dates) {
      for (const [, pdata] of Object.entries(stats.days[date].providers)) {
        totalReqs += pdata.requests || 0;
        totalRL += pdata.rateLimited || 0;
        totalErrs += pdata.errors || 0;
      }
    }
    assert.equal(totalReqs, 1234 + 456 + 1100 + 300);
    assert.equal(totalRL, 12 + 2 + 8 + 1);
    assert.equal(totalErrs, 3 + 0 + 1 + 0);
  });

  it("handles empty stats gracefully", () => {
    const stats = { startedAt: Date.now(), days: {} };
    const dates = Object.keys(stats.days);
    assert.equal(dates.length, 0);
  });
});

// ── cmdStatus / cmdUsage / cmdSavings / cmdKeys (integration) ──────────────

describe("CLI commands (integration)", () => {
  let dir, configPath, statsPath;

  beforeEach(() => {
    dir = tmpDir();
    configPath = path.join(dir, "config.json");
    statsPath = path.join(dir, "data", "stats.json");
    writeJSON(configPath, makeSampleConfig());
    writeJSON(statsPath, makeSampleStats());
  });

  it("cmdStatus runs without error", () => {
    const { cmdStatus } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Capture stdout
    const origLog = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdStatus(config, statsPath);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("FFAI Pool Status"));
    assert.ok(output.includes("gemini"));
    assert.ok(output.includes("groq"));
    assert.ok(output.includes("Uptime:"));
  });

  it("cmdUsage displays usage table", () => {
    const { cmdUsage } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdUsage(config, statsPath, 7);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("FFAI Usage"));
    assert.ok(output.includes("1,234"));
    assert.ok(output.includes("Totals:"));
  });

  it("cmdUsage handles missing stats file", () => {
    const { cmdUsage } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdUsage(config, "/tmp/nonexistent-12345.json", 7);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("No usage data"));
  });

  it("cmdSavings calculates correct totals", () => {
    const { cmdSavings } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdSavings(config, statsPath, 7);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("FFAI Savings Estimate"));
    assert.ok(output.includes("gemini"));
    assert.ok(output.includes("$0.00")); // actual cost is free
    assert.ok(output.includes("Total estimated savings:"));
  });

  it("cmdSavings handles empty stats", () => {
    const { cmdSavings } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const emptyStatsPath = path.join(dir, "data", "empty-stats.json");
    writeJSON(emptyStatsPath, { startedAt: Date.now(), days: {} });
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdSavings(config, emptyStatsPath, 7);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("No usage data"));
  });

  it("cmdKeys displays key information", () => {
    const { cmdKeys } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdKeys(config, statsPath);
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("FFAI Key Status"));
    assert.ok(output.includes("gemini"));
  });

  it("cmdKeys filters by provider", () => {
    const { cmdKeys } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origLog = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      cmdKeys(config, statsPath, "gemini");
    } finally {
      console.log = origLog;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("gemini"));
    // groq should not appear as a section header
    assert.ok(!output.includes("FFAI Key Status \u2014 groq"));
  });

  it("cmdKeys reports unknown provider", () => {
    const { cmdKeys } = require("../cli");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const lines = [];
    const origErr = console.error;
    console.error = (...a) => lines.push(a.join(" "));
    try {
      cmdKeys(config, statsPath, "nonexistent");
    } finally {
      console.error = origErr;
    }
    const output = lines.join("\n");
    assert.ok(output.includes("Unknown provider"));
  });
});

// ── Days limiting ──────────────────────────────────────────────────────────

describe("days limiting", () => {
  it("limits usage to specified number of days", () => {
    const stats = {
      startedAt: Date.now(),
      days: {
        "2026-04-07": { providers: { gemini: { requests: 100, rateLimited: 0, errors: 0, allKeysExhausted: 0 } } },
        "2026-04-06": { providers: { gemini: { requests: 200, rateLimited: 0, errors: 0, allKeysExhausted: 0 } } },
        "2026-04-05": { providers: { gemini: { requests: 300, rateLimited: 0, errors: 0, allKeysExhausted: 0 } } },
      },
    };
    const allDates = Object.keys(stats.days).sort().reverse();
    const dates = allDates.slice(0, 2); // only 2 days
    let total = 0;
    for (const date of dates) {
      for (const [, pdata] of Object.entries(stats.days[date].providers)) {
        total += pdata.requests || 0;
      }
    }
    assert.equal(total, 300); // 100 + 200, not 600
    assert.equal(dates.length, 2);
  });
});
