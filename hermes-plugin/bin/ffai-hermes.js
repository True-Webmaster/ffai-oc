#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { install } from "../lib/install.js";
import { syncProviders } from "../lib/sync.js";
import { uninstall } from "../lib/uninstall.js";

const COMMANDS = ["install", "sync", "uninstall", "help"];
const FLAGS_WITH_VALUE = new Set(["--url", "--key", "--timeout"]);

async function readVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, "..", "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function usage() {
  return [
    "ffai-hermes — register FFAI as a Hermes custom_providers source",
    "",
    "USAGE",
    "  ffai-hermes install [--url URL] [--key KEY] [--timeout MS]",
    "  ffai-hermes sync    [--url URL] [--key KEY] [--timeout MS]",
    "  ffai-hermes uninstall",
    "  ffai-hermes help",
    "  ffai-hermes --version",
    "",
    "OPTIONS",
    "  --url URL        FFAI bridge base URL (default: $FFAI_URL or http://127.0.0.1:8010)",
    "  --key KEY        FFAI auth key (default: $FFAI_KEY). install also writes this to ~/.hermes/.env.",
    "  --timeout MS     Discovery fetch timeout in ms (default: 15000, max: 120000)",
    "  --version, -v    Print version and exit",
    "  --help, -h       Print this help and exit",
    "",
    "Flags accept --name VALUE or --name=VALUE.",
    "",
    "FILES",
    "  ~/.hermes/config.yaml   custom_providers entries upserted under ffai-* names",
    "  ~/.hermes/.env          FFAI_KEY written by `install` only",
    "",
    "ENV",
    "  HERMES_HOME   override ~/.hermes location",
    "  FFAI_URL      default base URL",
    "  FFAI_KEY      default auth key",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // --name=value form
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      const name = a.slice(0, eq);
      const value = a.slice(eq + 1);
      if (!FLAGS_WITH_VALUE.has(name)) throw new Error(`unknown flag: ${name}`);
      args[name.slice(2)] = value;
      continue;
    }
    // --name value form
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error(`${a} requires a value`);
      args[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    }
    args._.push(a);
  }
  return args;
}

function parseTimeout(raw) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--timeout must be a positive number of ms (got ${raw})`);
  }
  // Cap at 2 minutes — anything longer is almost certainly a typo and an
  // unbounded `--timeout` would block CI / install scripts forever.
  if (n > 120_000) {
    throw new Error(`--timeout must be ≤ 120000 ms (got ${n})`);
  }
  return n;
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === "--version" || first === "-v") {
    console.log(await readVersion());
    return 0;
  }
  if (!first || first === "help" || first === "--help" || first === "-h") {
    console.log(usage());
    return 0;
  }
  if (!COMMANDS.includes(first)) {
    console.error(`unknown command: ${first}\n`);
    console.error(usage());
    return 2;
  }

  let args;
  try {
    args = parseArgs(argv.slice(1));
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  let timeoutMs;
  try {
    timeoutMs = parseTimeout(args.timeout);
  } catch (err) {
    console.error(err.message);
    return 2;
  }

  const opts = { baseUrl: args.url, apiKey: args.key, timeoutMs };

  try {
    if (first === "install") {
      const r = await install(opts);
      return r.ok ? 0 : 1;
    }
    if (first === "sync") {
      const r = await syncProviders(opts);
      return r.ok ? 0 : 1;
    }
    if (first === "uninstall") {
      await uninstall();
      return 0;
    }
  } catch (err) {
    console.error(`[hermes-plugin] ${err.message}`);
    return 1;
  }
  return 0;
}

main().then((code) => process.exit(code ?? 0));
