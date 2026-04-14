#!/usr/bin/env node
/**
 * FFAI CLI — operator-facing commands for pool visibility and savings.
 *
 * Usage:
 *   node engine/cli.js status              Pool health overview
 *   node engine/cli.js usage [--days N]    Usage breakdown
 *   node engine/cli.js savings [--days N]  Estimated savings
 *   node engine/cli.js keys [provider]     Per-key status
 *   node engine/cli.js health              Fetch /health?detailed from bridge
 *
 * Env vars:
 *   FFAI_CONFIG       Path to config.json (default: ./config.json)
 *   FFAI_STATS_FILE   Path to stats.json  (default: ./data/stats.json)
 *   FFAI_PORT         Bridge port for health command (default: 8010)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Helpers ────────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;

const color = {
  bold:    (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  green:   (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  red:     (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  yellow:  (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  cyan:    (s) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
  dim:     (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
};

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function fmtMoney(n) {
  return "$" + Number(n).toFixed(2);
}

const SEPARATOR = "\u2550".repeat(50);

const DEFAULT_PRICING = {
  gemini: 0.0025,
  groq: 0.001,
  openai: 0.01,
  anthropic: 0.015,
  default: 0.005,
};

// ── Parse args ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || "";
  const flags = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--days" && i + 1 < args.length) {
      flags.days = parseInt(args[++i], 10);
    } else if (args[i].startsWith("--days=")) {
      flags.days = parseInt(args[i].split("=")[1], 10);
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    }
  }

  return { command, flags, positional };
}

// ── Config / Stats loading ─────────────────────────────────────────────────

function loadConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`Config file not found: ${configPath}`);
      process.exit(1);
    }
    console.error(`Error reading config: ${err.message}`);
    process.exit(1);
  }
}

function loadStats(statsPath) {
  try {
    const raw = fs.readFileSync(statsPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    console.error(`Error reading stats: ${err.message}`);
    return null;
  }
}

function resolveKeys(provConfig) {
  if (Array.isArray(provConfig.keys) && provConfig.keys.length > 0) return provConfig.keys;
  if (provConfig.keys_var) {
    return (process.env[provConfig.keys_var] || "").split(",").map(k => k.trim()).filter(Boolean);
  }
  return [];
}

// ── Pool instantiation (read-only) ────────────────────────────────────────

function createPool(config) {
  const Pool = require("./lib/pool");
  const providerConfigs = {};
  for (const [name, pconf] of Object.entries(config.providers || {})) {
    const keys = resolveKeys(pconf);
    if (keys.length > 0) {
      providerConfigs[name] = { ...pconf, keys };
    }
  }
  return new Pool({
    providers: providerConfigs,
    statsFlushInterval: 0, // no auto-flush for CLI
    logger: { log() {}, warn() {}, error() {} }, // silent
  });
}

// ── Format uptime ──────────────────────────────────────────────────────────

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600) % 24;
  const d = Math.floor(s / 86400);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Commands ───────────────────────────────────────────────────────────────

function cmdStatus(config, statsPath) {
  const pool = createPool(config);
  const health = pool.health();
  const stats = loadStats(statsPath);

  console.log("");
  console.log(color.bold("FFAI Pool Status"));
  console.log(SEPARATOR);

  // Table header
  const header = padRow(["Provider", "Keys", "Available", "Scoring", "Status"]);
  console.log(color.bold(header));

  for (const [name, info] of Object.entries(health.providers)) {
    const status = info.status === "ok" ? color.green("ok") : color.red(info.status);
    console.log(padRow([
      name,
      String(info.keys.total),
      String(info.keys.available),
      info.scoring,
      status,
    ]));
  }

  console.log("");
  const uptimeMs = stats && stats.startedAt ? Date.now() - stats.startedAt : health.uptime;
  console.log(`Uptime: ${formatUptime(uptimeMs)}`);
  console.log("");

  pool.shutdown().catch(() => {});
}

function cmdUsage(config, statsPath, days) {
  const stats = loadStats(statsPath);
  if (!stats || !stats.days || Object.keys(stats.days).length === 0) {
    console.log("");
    console.log(color.bold(`FFAI Usage (last ${days} days)`));
    console.log(SEPARATOR);
    console.log(color.dim("No usage data found."));
    console.log("");
    return;
  }

  // Get the last N days sorted descending
  const allDates = Object.keys(stats.days).sort().reverse();
  const dates = allDates.slice(0, days);

  console.log("");
  console.log(color.bold(`FFAI Usage (last ${days} days)`));
  console.log(SEPARATOR);
  console.log(color.bold(padRow(["Date", "Provider", "Requests", "Rate-Limited", "Errors", "Exhausted"])));

  let totalReqs = 0, totalRL = 0, totalErrs = 0;

  for (const date of dates) {
    const dayData = stats.days[date];
    if (!dayData || !dayData.providers) continue;
    for (const [prov, pdata] of Object.entries(dayData.providers)) {
      const reqs = pdata.requests || 0;
      const rl = pdata.rateLimited || 0;
      const errs = pdata.errors || 0;
      const exhaust = pdata.allKeysExhausted || 0;
      totalReqs += reqs;
      totalRL += rl;
      totalErrs += errs;
      console.log(padRow([date, prov, fmt(reqs), fmt(rl), fmt(errs), fmt(exhaust)]));
    }
  }

  console.log("");
  console.log(`Totals: ${fmt(totalReqs)} requests, ${fmt(totalRL)} rate-limited, ${fmt(totalErrs)} errors`);
  console.log("");
}

function cmdSavings(config, statsPath, days) {
  const stats = loadStats(statsPath);
  const pricing = { ...DEFAULT_PRICING, ...(config.pricing || {}) };

  if (!stats || !stats.days || Object.keys(stats.days).length === 0) {
    console.log("");
    console.log(color.bold(`FFAI Savings Estimate (last ${days} days)`));
    console.log(SEPARATOR);
    console.log(color.dim("No usage data found."));
    console.log("");
    return;
  }

  const allDates = Object.keys(stats.days).sort().reverse();
  const dates = allDates.slice(0, days);

  // Aggregate by provider
  const byProvider = {};
  const byProviderCost = {};
  for (const date of dates) {
    const dayData = stats.days[date];
    if (!dayData || !dayData.providers) continue;
    for (const [prov, pdata] of Object.entries(dayData.providers)) {
      if (!byProvider[prov]) byProvider[prov] = 0;
      byProvider[prov] += pdata.requests || 0;
      if (!byProviderCost[prov]) byProviderCost[prov] = 0;
      byProviderCost[prov] += pdata.estimatedCost || 0;
    }
  }

  console.log("");
  console.log(color.bold(`FFAI Savings Estimate (last ${days} days)`));
  console.log(SEPARATOR);
  console.log(color.bold(padRow(["Provider", "Requests", "Est. Cost (paid)", "Actual Cost (free)", "Saved"])));

  let totalSaved = 0;
  for (const [prov, reqs] of Object.entries(byProvider)) {
    const rate = pricing[prov] ?? pricing.default;
    const estCost = reqs * rate;
    // Use actual tracked cost if available
    const actualTracked = byProviderCost[prov] || 0;
    const displayCost = actualTracked > 0 ? actualTracked : estCost;
    totalSaved += displayCost;
    console.log(padRow([prov, fmt(reqs), fmtMoney(displayCost), fmtMoney(0), fmtMoney(displayCost)]));
  }

  console.log("");
  console.log(color.bold(`Total estimated savings: ${color.green(fmtMoney(totalSaved))}`));
  console.log("");
}

function cmdKeys(config, statsPath, providerFilter) {
  const pool = createPool(config);
  const detailed = pool.healthDetailed();

  const providers = providerFilter
    ? { [providerFilter]: detailed.providers[providerFilter] }
    : detailed.providers;

  if (providerFilter && !detailed.providers[providerFilter]) {
    console.error(`Unknown provider: ${providerFilter}`);
    console.error(`Available: ${Object.keys(detailed.providers).join(", ")}`);
    pool.shutdown().catch(() => {});
    return;
  }

  for (const [name, info] of Object.entries(providers)) {
    console.log("");
    console.log(color.bold(`FFAI Key Status \u2014 ${name}`));
    console.log(SEPARATOR);

    if (!info.perKey || Object.keys(info.perKey).length === 0) {
      console.log(color.dim("No per-key data (scoring may be disabled)"));
      continue;
    }

    console.log(color.bold(padRow(["Key", "Score", "RPM", "TPM", "RPD", "Errors", "CB", "Cooldown"])));

    for (const [kid, kdata] of Object.entries(info.perKey)) {
      console.log(padRow([
        kid,
        kdata.score != null ? String(kdata.score) : "\u2014",
        kdata.rpm != null ? fmt(kdata.rpm) : "\u2014",
        kdata.tpm != null ? fmt(kdata.tpm) : "\u2014",
        kdata.rpd != null ? fmt(kdata.rpd) : "\u2014",
        String(kdata.consecutiveErrors || 0),
        kdata.perKeyCB || "closed",
        kdata.cooldown || "\u2014",
      ]));
    }
  }

  console.log("");
  pool.shutdown().catch(() => {});
}

function cmdHealth(port) {
  const url = `http://127.0.0.1:${port}/health?detailed`;
  console.log(color.dim(`Fetching ${url} ...`));

  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          console.log("");
          console.log(color.bold("FFAI Health (from bridge)"));
          console.log(SEPARATOR);
          console.log(JSON.stringify(data, null, 2));
          console.log("");
        } catch {
          console.error("Failed to parse response as JSON");
          console.log(body);
        }
        resolve();
      });
    });
    req.on("error", (err) => {
      console.error(`Could not connect to bridge at 127.0.0.1:${port}`);
      console.error(`Error: ${err.message}`);
      console.error("Is the FFAI bridge running? Start it with: node engine/serve.js");
      resolve();
    });
    req.setTimeout(5000, () => {
      req.destroy();
      console.error("Connection timed out");
      resolve();
    });
  });
}

// ── Table formatting ───────────────────────────────────────────────────────

function padRow(cols) {
  const widths = [12, 10, 10, 16, 10, 10];
  return cols.map((c, i) => {
    const w = widths[i] || 10;
    return String(c).padEnd(w);
  }).join("  ");
}

// ── Usage text ─────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
${color.bold("FFAI CLI")} - Pool visibility and savings calculator

${color.bold("Usage:")}
  node cli.js <command> [options]

${color.bold("Commands:")}
  status              Pool health overview
  usage [--days N]    Usage breakdown (default: 7 days)
  savings [--days N]  Estimated savings (default: 7 days)
  keys [provider]     Per-key status details
  health              Fetch /health?detailed from running bridge

${color.bold("Environment:")}
  FFAI_CONFIG         Path to config.json
  FFAI_STATS_FILE     Path to stats.json
  FFAI_PORT           Bridge port (default: 8010)
`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(argv) {
  const { command, flags, positional } = parseArgs(argv);

  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }

  const configPath = process.env.FFAI_CONFIG || path.join(__dirname, "config.json");
  const statsPath = process.env.FFAI_STATS_FILE || path.join(__dirname, "data", "stats.json");
  const port = parseInt(process.env.FFAI_PORT || "8010", 10);
  const days = flags.days || 7;

  switch (command) {
    case "status": {
      const config = loadConfig(configPath);
      cmdStatus(config, statsPath);
      break;
    }
    case "usage": {
      const config = loadConfig(configPath);
      cmdUsage(config, statsPath, days);
      break;
    }
    case "savings": {
      const config = loadConfig(configPath);
      cmdSavings(config, statsPath, days);
      break;
    }
    case "keys": {
      const config = loadConfig(configPath);
      cmdKeys(config, statsPath, positional[0]);
      break;
    }
    case "health": {
      await cmdHealth(port);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

// Export internals for testing
module.exports = {
  parseArgs,
  fmt,
  fmtMoney,
  formatUptime,
  padRow,
  loadStats,
  DEFAULT_PRICING,
  cmdStatus,
  cmdUsage,
  cmdSavings,
  cmdKeys,
  cmdHealth,
  main,
};

// Run if invoked directly
if (require.main === module) {
  main(process.argv).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
