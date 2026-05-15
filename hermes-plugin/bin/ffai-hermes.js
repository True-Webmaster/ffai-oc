#!/usr/bin/env node
import { install } from "../lib/install.js";
import { syncProviders } from "../lib/sync.js";
import { uninstall } from "../lib/uninstall.js";

const COMMANDS = ["install", "sync", "uninstall", "help"];

function usage() {
  return [
    "ffai-hermes — register FFAI as a Hermes custom_providers source",
    "",
    "USAGE",
    "  ffai-hermes install [--url URL] [--key KEY]",
    "  ffai-hermes sync    [--url URL] [--key KEY]",
    "  ffai-hermes uninstall",
    "  ffai-hermes help",
    "",
    "OPTIONS",
    "  --url URL    FFAI bridge base URL (default: $FFAI_URL or http://127.0.0.1:8010)",
    "  --key KEY    FFAI auth key (default: $FFAI_KEY). install also writes this to ~/.hermes/.env.",
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
    if (a === "--url" || a === "--key") {
      const v = argv[++i];
      if (typeof v !== "string") throw new Error(`${a} requires a value`);
      args[a.slice(2)] = v;
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(usage());
    return 0;
  }
  if (!COMMANDS.includes(cmd)) {
    console.error(`unknown command: ${cmd}\n`);
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

  const opts = { baseUrl: args.url, apiKey: args.key };

  try {
    if (cmd === "install") {
      const r = await install(opts);
      return r.ok ? 0 : 1;
    }
    if (cmd === "sync") {
      const r = await syncProviders(opts);
      return r.ok ? 0 : 1;
    }
    if (cmd === "uninstall") {
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
