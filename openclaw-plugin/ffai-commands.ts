/**
 * FFAI plugin command handlers — /ffai_stats, /ffai_encrypt, /ffai_import_keys.
 *
 * Separated from index.ts so the command surface (network + fs) stays distinct
 * from plugin wiring. All env-derived values are passed in as resolved params;
 * this module never touches process.env directly.
 *
 * Every outbound request goes through fetchWithSsrFGuard so an attacker who
 * can influence the FFAI baseUrl (e.g. via a compromised plugin config) can't
 * pivot to internal metadata endpoints.
 */
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { buildFfaiSsrfPolicy, buildFfaiEndpointUrl } from "./models.js";
import { findTailscaleIp, isLoopbackHost } from "./catalog-sync.js";

/**
 * Returns an AbortController + cleanup helper. Use over `AbortSignal.timeout`
 * so the timer can be explicitly cleared once the body has been consumed —
 * otherwise a slow body read can race the abort and surface a confusing
 * "AbortError" on a request that actually succeeded.
 */
function timeoutSignal(ms: number): { signal: AbortSignal; cleanup: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, cleanup: () => clearTimeout(t) };
}

const MAX_IMPORT_BLOB_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * Sanitize a server-supplied provider name before interpolating it into a
 * channel-rendered string. Channel renderers (Telegram MarkdownV2, Discord)
 * interpret formatting characters; an unsanitized name like
 * `[click](http://attacker)` becomes a clickable link.
 */
function sanitizeProviderName(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64);
  return trimmed || "unknown";
}

// ── Public exports ──────────────────────────────────────────────────────────

export type CommandResult = {
  text: string;
  isError?: boolean;
  mediaUrl?: string;
};

export async function handleFfaiStats(params: {
  baseUrl: string;
  apiKey: string | undefined;
}): Promise<CommandResult> {
  const { baseUrl, apiKey } = params;
  if (!apiKey) {
    return {
      text:
        "FFAI_KEY is not visible to this gateway process.\n\n" +
        "If you've set FFAI_KEY in .env but the gateway was started before that change, " +
        "the running process won't see it until restart — env is read at startup, not on demand.\n\n" +
        "Fix: set FFAI_KEY in the gateway environment, restart the gateway, then run /ffai_doctor.",
      isError: true,
    };
  }

  const url = buildFfaiEndpointUrl(baseUrl, "/savings");
  if (!url) return { text: "Invalid FFAI base URL.", isError: true };

  return ffaiRequest(
    {
      url,
      init: {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      },
      timeoutMs: 10_000,
      baseUrl,
      audit: "ffai-provider.stats",
    },
    async (response) => {
      let data: unknown;
      try {
        data = await response.json();
      } catch (err) {
        return { text: `FFAI /savings returned invalid JSON: ${redactSecrets(describe(err))}`, isError: true };
      }
      const savings = toSavingsResponse(data);
      if (!savings) {
        return { text: "FFAI /savings returned unexpected shape", isError: true };
      }
      return { text: formatSavingsStats(savings) };
    },
  );
}

export async function handleFfaiEncrypt(params: {
  baseUrl: string;
  adminKey: string | undefined;
}): Promise<CommandResult> {
  const { baseUrl, adminKey } = params;
  if (!adminKey) {
    return {
      text:
        "FFAI_ADMIN_KEY is not visible to this gateway process.\n\n" +
        "Two common causes:\n" +
        "  1. The variable isn't set anywhere — add `FFAI_ADMIN_KEY=...` to the gateway's .env or systemd unit.\n" +
        "  2. It IS set in your shell or .env, but the gateway was started before that change. " +
        "The running process reads env at startup; updating .env after the gateway is up has no effect until restart.\n\n" +
        "Fix: set FFAI_ADMIN_KEY in the gateway environment, then RESTART the gateway. " +
        "Run /ffai_doctor afterwards to confirm the env var is live.",
      isError: true,
    };
  }

  const url = buildFfaiEndpointUrl(baseUrl, "/generate-import");
  if (!url) return { text: "Invalid FFAI base URL.", isError: true };

  return ffaiRequest(
    {
      url,
      init: {
        headers: { Authorization: `Bearer ${adminKey}`, Accept: "text/html" },
      },
      timeoutMs: 15_000,
      baseUrl,
      audit: "ffai-provider.generate-import",
    },
    async (response) => {
      let html: string;
      try {
        html = await response.text();
      } catch (err) {
        return { text: `FFAI /generate-import read failed: ${redactSecrets(describe(err))}`, isError: true };
      }

      // Sanity-check: the response must look like an HTML page from the FFAI
      // encrypt endpoint. If the server is compromised or misconfigured and
      // returns something unexpected, refuse to write it to disk — opening
      // arbitrary content from file:// origin is a stored-XSS vector.
      if (!html.includes("<!DOCTYPE html") && !html.includes("<html")) {
        return { text: "FFAI /generate-import returned non-HTML content — refusing to write to disk.", isError: true };
      }
      if (!html.includes("FFAI-IMPORT") && !html.includes("ffai") && !html.includes("encrypt")) {
        return { text: "FFAI /generate-import returned unexpected HTML — refusing to write to disk.", isError: true };
      }

      // Single atomic write to a plugin-owned path under the OS tmp dir
      // (matches OpenClaw's default media root). tmp+rename avoids a
      // torn-file window where the Telegram channel could read a
      // half-written HTML blob.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const os = await import("node:os");

      const outDir = path.join(os.tmpdir(), "openclaw");
      const outPath = path.join(outDir, "ffai_encrypt.html");

      try {
        fs.mkdirSync(outDir, { recursive: true });
        const tmp = `${outPath}.tmp`;
        fs.writeFileSync(tmp, html, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(tmp, outPath);
      } catch (err) {
        return { text: `Failed to write ffai_encrypt.html: ${redactSecrets(describe(err))}`, isError: true };
      }

      return {
        text: "ffai_encrypt.html — open in browser, paste API keys, encrypt, then paste the FFAI-IMPORT blob back here.",
        mediaUrl: outPath,
      };
    },
  );
}

export async function handleFfaiImportKeys(params: {
  baseUrl: string;
  blob: string;
}): Promise<CommandResult> {
  const { baseUrl } = params;
  const raw = params.blob.trim();
  if (!raw) {
    return {
      text: "No import blob provided. Paste the FFAI-IMPORT:... string as the argument.",
      isError: true,
    };
  }

  // Bound size before doing anything else — accepting an arbitrarily large
  // blob would let a hostile pasted string consume memory and bandwidth
  // before the FFAI server gets a chance to reject it.
  if (raw.length > MAX_IMPORT_BLOB_BYTES) {
    return {
      text: `Import blob too large (${raw.length} bytes, max ${MAX_IMPORT_BLOB_BYTES}).`,
      isError: true,
    };
  }

  // Require the explicit FFAI-IMPORT: prefix and a strict charset for the
  // remainder. The previous base64-prefix heuristic (`/^eyJ/`) was ambiguous
  // and happy to promote any base64 JSON to an import attempt; the tight
  // charset stops anything weird (control characters, JSON-injection
  // attempts) before it reaches the server.
  if (!/^FFAI-IMPORT:[A-Za-z0-9+/=._-]+$/.test(raw)) {
    return {
      text: "Invalid import blob. It must start with FFAI-IMPORT: and contain only base64-safe characters (regenerate via /ffai_encrypt).",
      isError: true,
    };
  }
  const blob = raw;

  const url = buildFfaiEndpointUrl(baseUrl, "/import");
  if (!url) return { text: "Invalid FFAI base URL.", isError: true };

  return ffaiRequest(
    {
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ payload: blob }),
      },
      timeoutMs: 15_000,
      baseUrl,
      audit: "ffai-provider.import",
    },
    async (response) => {
      let data: {
        imported?: unknown;
        provider?: unknown;
        duplicates?: unknown;
        invalid?: unknown;
        mismatched?: unknown;
        message?: unknown;
        restart_hint?: unknown;
        provider_auto_created?: unknown;
        error?: unknown;
      };
      try {
        data = (await response.json()) as typeof data;
      } catch {
        return {
          text: "FFAI /import returned an invalid response body.",
          isError: true,
        };
      }

      // Every server-supplied string passes through `redactSecrets` before
      // being interpolated into channel-rendered output. A malicious or
      // buggy FFAI server could otherwise echo Bearer tokens or API keys
      // straight to the operator's chat.
      if (data.error) {
        const errMsg = redactSecrets(String(data.error)).slice(0, 600);
        return { text: `FFAI /import error: ${errMsg}`, isError: true };
      }

      const imported = typeof data.imported === "number" ? data.imported : 0;
      const duplicates = typeof data.duplicates === "number" ? data.duplicates : 0;
      const invalid = typeof data.invalid === "number" ? data.invalid : 0;
      const mismatched = typeof data.mismatched === "number" ? data.mismatched : 0;
      const provider = sanitizeProviderName(data.provider);

      if (imported === 0) {
        const rawMsg = typeof data.message === "string" ? data.message : "no keys imported";
        const msg = redactSecrets(rawMsg).slice(0, 600);
        return { text: `FFAI /import: ${msg} (provider "${provider}")`, isError: mismatched > 0 };
      }

      const extras: string[] = [];
      if (duplicates > 0) extras.push(`${duplicates} duplicate(s) skipped`);
      if (invalid > 0) extras.push(`${invalid} invalid`);
      if (mismatched > 0) extras.push(`${mismatched} did not match "${provider}" format`);
      const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
      const autoCreatedLine = data.provider_auto_created === true
        ? `\nProvider stanza for "${provider}" was auto-created in FFAI's config.json from a built-in template.`
        : "";
      const restartHint = typeof data.restart_hint === "string"
        ? `\n\nNote: ${redactSecrets(data.restart_hint).slice(0, 600)}`
        : "";
      return {
        text: `Keys imported successfully! ${imported} key(s) added for provider "${provider}"${suffix}.${autoCreatedLine}${restartHint}`,
      };
    },
  );
}

// ── /ffai_doctor — preflight diagnostics ────────────────────────────────────
//
// Runs the same checks an installer's "did this actually work?" step would
// run, prints OK/FAIL per check with one-line remediation hints, and returns
// a summary count. Designed to catch every common install-time failure mode
// (FFAI unreachable, env var missing from gateway process, no providers
// configured, no keys, catalog-sync hasn't populated openclaw.json,
// allowlist gating /models output) without the operator having to chase
// logs or grep config files.

type DoctorCheck = {
  name: string;
  status: "ok" | "warn" | "fail" | "skip";
  detail: string;
  remediation?: string;
};

export async function handleFfaiDoctor(params: {
  baseUrl: string;
  apiKey: string | undefined;
  adminKey: string | undefined;
  openclawConfig: unknown;
}): Promise<CommandResult> {
  const { baseUrl, apiKey, adminKey, openclawConfig } = params;
  const checks: DoctorCheck[] = [];

  // 1. Plugin loaded — we're running, so this is implicit. Surface it
  //    anyway because operators reading the output want to confirm.
  checks.push({
    name: "plugin loaded",
    status: "ok",
    detail: "this command ran, so the plugin's register() executed",
  });

  // 2. Gateway env: FFAI_KEY visible to the running process
  if (apiKey) {
    checks.push({
      name: "FFAI_KEY in gateway env",
      status: "ok",
      detail: "present",
    });
  } else {
    checks.push({
      name: "FFAI_KEY in gateway env",
      status: "fail",
      detail: "missing",
      remediation:
        "Set FFAI_KEY in the gateway environment (.env or systemd unit) and RESTART the gateway. " +
        "The running process reads env at startup; updating .env after the gateway is up has no effect until restart.",
    });
  }

  // 3. Gateway env: FFAI_ADMIN_KEY (only required for /ffai_encrypt)
  if (adminKey) {
    checks.push({
      name: "FFAI_ADMIN_KEY in gateway env",
      status: "ok",
      detail: "present",
    });
  } else {
    checks.push({
      name: "FFAI_ADMIN_KEY in gateway env",
      status: "warn",
      detail: "missing",
      remediation:
        "Optional — needed only for /ffai_encrypt. If you plan to import keys via the encrypt page, " +
        "set FFAI_ADMIN_KEY in the gateway environment and restart the gateway.",
    });
  }

  // 4. FFAI reachability + provider count via /providers
  let providerNames: string[] = [];
  let providerHealthOk = false;
  if (!apiKey) {
    checks.push({
      name: "FFAI reachable",
      status: "skip",
      detail: "skipped (no FFAI_KEY to authenticate)",
    });
  } else {
    const providersResult = await probeFfaiProviders({ baseUrl, apiKey });
    if (providersResult.ok) {
      providerHealthOk = true;
      providerNames = providersResult.providers;
      checks.push({
        name: "FFAI reachable",
        status: "ok",
        detail: `${baseUrl} responded ok`,
      });
      if (providerNames.length === 0) {
        checks.push({
          name: "FFAI providers configured",
          status: "fail",
          detail: "FFAI is running but has zero providers in config.json",
          remediation:
            "Add at least one provider stanza to FFAI's config.json. " +
            "See config.json.example in the FFAI repo for templates (gemini, groq, cerebras, ollama, sambanova).",
        });
      } else {
        checks.push({
          name: "FFAI providers configured",
          status: "ok",
          detail: `${providerNames.length} provider(s): ${providerNames.join(", ")}`,
        });

        // 5. At least one key per provider
        const keyDetails = providersResult.providerDetails;
        const emptyProviders: string[] = [];
        const ok: string[] = [];
        for (const name of providerNames) {
          const total = keyDetails[name]?.total ?? 0;
          if (total === 0) emptyProviders.push(name);
          else ok.push(`${name}=${total}`);
        }
        if (emptyProviders.length === providerNames.length) {
          checks.push({
            name: "FFAI keys configured",
            status: "fail",
            detail: `every provider has zero keys (${providerNames.join(", ")})`,
            remediation:
              "Set the matching `keys_var` env vars (e.g. GEMINI_KEYS, GROQ_KEYS) and restart FFAI, " +
              "OR run /ffai_encrypt to import keys via the encrypted blob flow.",
          });
        } else if (emptyProviders.length > 0) {
          checks.push({
            name: "FFAI keys configured",
            status: "warn",
            detail: `keys: ${ok.join(", ")}; empty: ${emptyProviders.join(", ")}`,
            remediation:
              "Some providers have keys; others have none. Either populate the empty ones (env or import) " +
              "or remove them from FFAI's config.json so they don't show up in /models as broken entries.",
          });
        } else {
          checks.push({
            name: "FFAI keys configured",
            status: "ok",
            detail: `keys per provider: ${ok.join(", ")}`,
          });
        }
      }
    } else {
      let host = baseUrl;
      try { host = new URL(baseUrl).host; } catch { /* malformed — fall through with full URL */ }
      checks.push({
        name: "FFAI reachable",
        status: "fail",
        detail: `${baseUrl} unreachable (${providersResult.reason})`,
        remediation:
          `Verify FFAI is running and bound to ${host}. ` +
          "If FFAI is on a different host or port, set FFAI_URL in the gateway environment and restart.",
      });
    }
  }

  // 6. /models returns at least one model
  if (!apiKey) {
    checks.push({
      name: "FFAI /models populated",
      status: "skip",
      detail: "skipped (no FFAI_KEY)",
    });
  } else if (!providerHealthOk) {
    checks.push({
      name: "FFAI /models populated",
      status: "skip",
      detail: "skipped (FFAI unreachable)",
    });
  } else {
    const modelsResult = await probeFfaiModels({ baseUrl, apiKey });
    if (modelsResult.ok) {
      if (modelsResult.modelCount === 0) {
        checks.push({
          name: "FFAI /models populated",
          status: "fail",
          detail: "/models returned an empty list",
          remediation:
            "FFAI has providers but discovery hasn't populated any models yet. " +
            "Check FFAI logs for [discovery] errors. Common causes: invalid API keys, " +
            "FFAI_MIN_CONTEXT_WINDOW / FFAI_MIN_TPM filtering everything out.",
        });
      } else {
        checks.push({
          name: "FFAI /models populated",
          status: "ok",
          detail: `${modelsResult.modelCount} model(s) discovered`,
        });
      }
    } else {
      checks.push({
        name: "FFAI /models populated",
        status: "fail",
        detail: `/models returned ${modelsResult.reason}`,
      });
    }
  }

  // 7. catalog-sync wrote ffai-* providers into openclaw.json
  const cfg = openclawConfig as { models?: { providers?: Record<string, unknown> } } | undefined;
  const ffaiProvidersInConfig = Object.keys(cfg?.models?.providers ?? {})
    .filter((p) => p.startsWith("ffai-"));
  if (ffaiProvidersInConfig.length === 0) {
    checks.push({
      name: "openclaw.json catalog-sync",
      status: "fail",
      detail: "no ffai-* providers in models.providers",
      remediation:
        "catalog-sync hasn't run successfully yet, or it ran when FFAI was unreachable. " +
        "Restart the gateway after FFAI is reachable. If catalog-sync logs show retry exhaustion, " +
        "check FFAI's /providers endpoint manually.",
    });
  } else {
    checks.push({
      name: "openclaw.json catalog-sync",
      status: "ok",
      detail: `${ffaiProvidersInConfig.length} ffai-* provider(s): ${ffaiProvidersInConfig.join(", ")}`,
    });
  }

  // 8. Allowlist coverage — if agents.defaults.models is non-empty, every
  //    discovered ffai-* model ref should be in it (otherwise /models hides
  //    them).
  const allowlist = (cfg as {
    agents?: { defaults?: { models?: Record<string, unknown> } };
  } | undefined)?.agents?.defaults?.models;
  if (!allowlist || Object.keys(allowlist).length === 0) {
    checks.push({
      name: "/models allowlist coverage",
      status: "ok",
      detail: "no allowlist (all discovered models visible)",
    });
  } else {
    const allowlistKeys = new Set(Object.keys(allowlist));
    let totalRefs = 0;
    let covered = 0;
    for (const provKey of ffaiProvidersInConfig) {
      const provRaw = (cfg?.models?.providers as Record<string, unknown>)?.[provKey];
      // Provider entry may be a non-object if the user hand-edited
      // openclaw.json badly; skip rather than crash.
      if (typeof provRaw !== "object" || provRaw === null) continue;
      const prov = provRaw as { models?: unknown };
      const models = Array.isArray(prov.models) ? prov.models : [];
      for (const m of models) {
        if (typeof m !== "object" || m === null) continue;
        const idRaw = (m as { id?: unknown }).id;
        const id = typeof idRaw === "string" ? idRaw : null;
        if (!id) continue;
        totalRefs++;
        if (allowlistKeys.has(`${provKey}/${id}`)) covered++;
      }
    }
    if (totalRefs === 0) {
      checks.push({
        name: "/models allowlist coverage",
        status: "skip",
        detail: "no ffai-* models to check",
      });
    } else if (covered === totalRefs) {
      checks.push({
        name: "/models allowlist coverage",
        status: "ok",
        detail: `${covered}/${totalRefs} ffai-* model refs in allowlist`,
      });
    } else {
      checks.push({
        name: "/models allowlist coverage",
        status: "warn",
        detail: `${covered}/${totalRefs} ffai-* model refs in allowlist`,
        remediation:
          `${totalRefs - covered} model(s) discovered but not in agents.defaults.models. ` +
          "Restart the gateway so catalog-sync's allowlist pass runs again, or add them manually.",
      });
    }
  }

  // 9. Discord-specific gotcha: the Discord channel plugin hides
  //    providers whose baseUrl looks like loopback (127.0.0.1, localhost,
  //    0.0.0.0). FFAI defaults to 127.0.0.1:8010, so users running Discord
  //    + FFAI on the same host see no ffai-* entries in Discord's /models
  //    while Telegram works fine. See openclaw/openclaw#35516. Surface
  //    this as a warn whenever the combo is detected.
  //
  //    catalog-sync auto-flips the published baseUrl to a Tailscale IP
  //    when one is reachable (see catalog-sync.ts → resolveDetectedBaseUrl).
  //    The doctor's `baseUrl` arg is the runtime resolution from index.ts,
  //    which doesn't apply that auto-flip. We do the same detection here
  //    so the doctor reports the actual user-visible state.
  const discordConfigured = isDiscordConfigured(openclawConfig);
  const baseUrlIsLoopback = isLoopbackBaseUrl(baseUrl);
  const tailscaleIp = findTailscaleIp();
  if (discordConfigured && baseUrlIsLoopback) {
    const tailscaleHint = tailscaleIp
      ? `A Tailscale interface is available (${tailscaleIp}). To use it: ` +
        `set FFAI_BIND=0.0.0.0 (so FFAI listens on all interfaces) and ` +
        `FFAI_URL=http://${tailscaleIp}:8010, then restart both FFAI and the gateway. ` +
        "catalog-sync also auto-flips to Tailscale at gateway start when FFAI is " +
        "reachable there — restarting the gateway after FFAI_BIND is changed should " +
        "do this automatically."
      : "No Tailscale interface detected. Set FFAI_URL to a non-loopback address " +
        "(Tailscale IP, private LAN IP, or hostname) and restart the gateway. " +
        "Installing Tailscale (https://tailscale.com) is the recommended path.";
    checks.push({
      name: "Discord/loopback compatibility",
      status: "warn",
      detail: `Discord channel detected and baseUrl=${baseUrl} resolves to loopback`,
      remediation:
        "Discord's /models picker silently hides providers with a loopback baseUrl " +
        `(see openclaw/openclaw#35516). ${tailscaleHint} ` +
        "ffai-* models will then appear in Discord's /models alongside Telegram. " +
        "See the README FAQ for more detail.",
    });
  } else if (discordConfigured) {
    checks.push({
      name: "Discord/loopback compatibility",
      status: "ok",
      detail: `Discord channel detected; baseUrl=${baseUrl} is non-loopback`,
    });
  }

  // 10. Tailscale availability — informational only. Reports whether the
  //     gateway host has a Tailscale interface and whether catalog-sync
  //     should be using it. This fires regardless of whether Discord is
  //     configured because the auto-flip is the recommended setup
  //     even for Telegram-only users (sets up cleanly if they later add
  //     Discord).
  if (tailscaleIp) {
    if (baseUrlIsLoopback) {
      checks.push({
        name: "Tailscale auto-flip",
        status: "warn",
        detail: `Tailscale interface present (${tailscaleIp}) but baseUrl=${baseUrl} is loopback`,
        remediation:
          `catalog-sync prefers Tailscale when FFAI is reachable there. Currently ` +
          `it isn't (FFAI is bound to loopback only). To enable: set FFAI_BIND=0.0.0.0 ` +
          `in FFAI's environment, restart FFAI, then restart the gateway. ` +
          `catalog-sync will detect the Tailscale interface, probe ${tailscaleIp}:` +
          `<port>, and publish the Tailscale URL automatically — making the catalog ` +
          `Discord-friendly without you doing anything else.`,
      });
    } else {
      checks.push({
        name: "Tailscale auto-flip",
        status: "ok",
        detail: `Tailscale interface present (${tailscaleIp}) and baseUrl=${baseUrl} is non-loopback`,
      });
    }
  }

  // ── Format output ─────────────────────────────────────────────────────────
  const lines: string[] = ["FFAI doctor — preflight diagnostics", "─".repeat(40)];
  let pass = 0, warn = 0, fail = 0, skip = 0;
  for (const check of checks) {
    const icon = check.status === "ok" ? "✓"
      : check.status === "warn" ? "⚠"
      : check.status === "fail" ? "✗"
      : "·";
    lines.push(`${icon} ${check.name}: ${check.detail}`);
    if (check.remediation) {
      lines.push(`    → ${check.remediation}`);
    }
    if (check.status === "ok") pass++;
    else if (check.status === "warn") warn++;
    else if (check.status === "fail") fail++;
    else skip++;
  }
  lines.push("─".repeat(40));
  lines.push(`Summary: ${pass} ok · ${warn} warn · ${fail} fail · ${skip} skipped`);
  if (fail > 0) {
    lines.push("");
    lines.push(
      "One or more checks failed. Resolve the items above (each fix is shown after the failing line), " +
        "then re-run /ffai_doctor.",
    );
  } else if (warn > 0) {
    lines.push("");
    lines.push("Warnings are non-fatal but worth investigating before relying on this in production.");
  }

  return { text: lines.join("\n"), isError: fail > 0 };
}

/**
 * True if the gateway has the Discord channel plugin configured.
 * Checks both the channel binding (`channels.discord`) and the plugin
 * registration (`plugins.entries.discord.enabled`); either is enough to
 * surface the loopback-filter warning.
 */
function isDiscordConfigured(openclawConfig: unknown): boolean {
  const cfg = openclawConfig as {
    channels?: Record<string, unknown>;
    plugins?: { entries?: Record<string, { enabled?: unknown }> };
  } | undefined;
  // A truthy primitive (`channels.discord: 0` slips through TS because the
  // field is `unknown`); require an actual object before declaring Discord
  // configured.
  const ch = cfg?.channels?.discord;
  if (typeof ch === "object" && ch !== null) return true;
  const entry = cfg?.plugins?.entries?.discord;
  return entry?.enabled === true;
}

/**
 * True if the URL's hostname looks like loopback. Wraps `isLoopbackHost`
 * (in catalog-sync.ts) with URL parsing so we don't re-implement the
 * regex set here.
 */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

async function probeFfaiProviders(params: { baseUrl: string; apiKey: string }): Promise<
  | { ok: true; providers: string[]; providerDetails: Record<string, { total: number }> }
  | { ok: false; reason: string }
> {
  const url = buildFfaiEndpointUrl(params.baseUrl, "/providers");
  if (!url) return { ok: false, reason: "invalid baseUrl" };
  const { signal, cleanup } = timeoutSignal(5_000);
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url,
      init: {
        headers: { Authorization: `Bearer ${params.apiKey}`, Accept: "application/json" },
        signal,
      },
      policy: buildFfaiSsrfPolicy(params.baseUrl),
      auditContext: "ffai-provider.doctor.providers",
    });
    release = result.release;
    if (!result.response.ok) return { ok: false, reason: `HTTP ${result.response.status}` };
    let data: unknown;
    try { data = await result.response.json(); }
    catch { return { ok: false, reason: "invalid JSON" }; }
    const map = (data && typeof data === "object" && "providers" in data
      && typeof (data as { providers?: unknown }).providers === "object")
      ? (data as { providers: Record<string, unknown> }).providers
      : null;
    if (!map) return { ok: false, reason: "missing providers field" };
    const providers = Object.keys(map);
    const providerDetails: Record<string, { total: number }> = {};
    for (const name of providers) {
      const p = map[name] as { keys?: unknown } | undefined;
      const total = typeof p?.keys === "number" ? p.keys : 0;
      providerDetails[name] = { total };
    }
    return { ok: true, providers, providerDetails };
  } catch (err) {
    // Errors from undici/fetch can include the full URL with credentials;
    // redact before surfacing as a doctor `reason`.
    return { ok: false, reason: redactSecrets(describe(err)) };
  } finally {
    cleanup();
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

async function probeFfaiModels(params: { baseUrl: string; apiKey: string }): Promise<
  | { ok: true; modelCount: number }
  | { ok: false; reason: string }
> {
  const url = buildFfaiEndpointUrl(params.baseUrl, "/models");
  if (!url) return { ok: false, reason: "invalid baseUrl" };
  const { signal, cleanup } = timeoutSignal(10_000);
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url,
      init: {
        headers: { Authorization: `Bearer ${params.apiKey}`, Accept: "application/json" },
        signal,
      },
      policy: buildFfaiSsrfPolicy(params.baseUrl),
      auditContext: "ffai-provider.doctor.models",
    });
    release = result.release;
    if (!result.response.ok) return { ok: false, reason: `HTTP ${result.response.status}` };
    let data: unknown;
    try { data = await result.response.json(); }
    catch { return { ok: false, reason: "invalid JSON" }; }
    const list = (data && typeof data === "object" && "data" in data
      && Array.isArray((data as { data?: unknown }).data))
      ? (data as { data: unknown[] }).data
      : null;
    if (!list) return { ok: false, reason: "missing data array" };
    return { ok: true, modelCount: list.length };
  } catch (err) {
    return { ok: false, reason: redactSecrets(describe(err)) };
  } finally {
    cleanup();
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

// ── Shared fetch helper ─────────────────────────────────────────────────────

/**
 * Single chokepoint for outbound FFAI requests. Routes through the SDK SSRF
 * guard, holds the guard's release slot until the caller has consumed the
 * response body, and converts non-ok / thrown states into redacted
 * CommandResult errors so handlers stay linear.
 */
async function ffaiRequest(
  params: { url: string; init: RequestInit; timeoutMs: number; baseUrl: string; audit: string },
  consume: (response: Response) => Promise<CommandResult>,
): Promise<CommandResult> {
  const { signal, cleanup } = timeoutSignal(params.timeoutMs);
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url: params.url,
      init: { ...params.init, signal },
      policy: buildFfaiSsrfPolicy(params.baseUrl),
      auditContext: params.audit,
    });
    release = result.release;
    const response = result.response;

    if (!response.ok) {
      const body = await safeReadBody(response, MAX_ERROR_BODY_BYTES);
      // Redact first, THEN slice — slicing a 200-char window before
      // redaction could truncate mid-token and leave a secret exposed.
      const redacted = redactSecrets(body).slice(0, 300);
      return {
        text: `FFAI returned ${response.status}: ${redacted || response.statusText}`,
        isError: true,
      };
    }

    return await consume(response);
  } catch (err) {
    return { text: `Failed to reach FFAI: ${redactSecrets(describe(err))}`, isError: true };
  } finally {
    cleanup();
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

/**
 * Read at most `maxBytes` of a response body as UTF-8 text. Bounds memory
 * usage when an error response (5xx HTML page, attacker-controlled) could
 * otherwise tie up the channel. Returns an empty string on read failure or
 * abort — the caller has already decided to surface an error.
 */
async function safeReadBody(response: Response, maxBytes: number): Promise<string> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return await response.text();
    const chunks: Uint8Array[] = [];
    let received = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        const remaining = maxBytes - received;
        if (remaining <= 0) {
          try { await reader.cancel(); } catch { /* best effort */ }
          break;
        }
        const slice = value.byteLength > remaining ? value.slice(0, remaining) : value;
        chunks.push(slice);
        received += slice.byteLength;
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
    return new TextDecoder("utf-8").decode(merged);
  } catch {
    return "";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk-[A-Za-z0-9_-]{10,})/g,
  /\b(?:gsk_[A-Za-z0-9_-]{10,})/g,
  /\b(?:csk-[A-Za-z0-9_-]{10,})/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,                                        // AWS access key IDs
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\/\/[^@\s]+:[^@\s]+@/g,                                       // URL-embedded user:pass@
  /[?&](?:api[_-]?key|token|key|password|secret|access[_-]?token)=[^&\s"'<>]+/gi, // querystring creds
];

function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try { return String(err); } catch { return "unknown error"; }
}

// ── Savings response validation ────────────────────────────────────────────

type UsagePeriodStats = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostAvoided: number;
  byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number; estimatedCostAvoided: number }>;
};

type SmushPeriodStats = {
  requests: number;
  bytesSaved: number;
  tokensSaved: number;
  costSaved: number;
  cacheHits: number;
  cmdCompressed: number;
  summarized: number;
  textCompressed: number;
  byProvider: Record<string, { requests: number; tokensSaved: number; costSaved: number }>;
};

type SavingsPeriod = {
  usage: UsagePeriodStats;
  compression: SmushPeriodStats;
};

type SavingsResponse = {
  today: SavingsPeriod;
  month: SavingsPeriod;
  lifetime: SavingsPeriod;
  smushEnabled: boolean;
  cacheSize: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toUsagePeriod(raw: unknown): UsagePeriodStats {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const byProviderRaw = (r.byProvider && typeof r.byProvider === "object" ? r.byProvider : {}) as Record<string, unknown>;
  const byProvider: UsagePeriodStats["byProvider"] = {};
  for (const [k, v] of Object.entries(byProviderRaw)) {
    const p = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    byProvider[k] = {
      requests: num(p.requests),
      inputTokens: num(p.inputTokens),
      outputTokens: num(p.outputTokens),
      estimatedCostAvoided: num(p.estimatedCostAvoided),
    };
  }
  return {
    requests: num(r.requests),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    estimatedCostAvoided: num(r.estimatedCostAvoided),
    byProvider,
  };
}

function toSmushPeriod(raw: unknown): SmushPeriodStats {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    requests: num(r.requests),
    bytesSaved: num(r.bytesSaved),
    tokensSaved: num(r.tokensSaved),
    costSaved: num(r.costSaved),
    cacheHits: num(r.cacheHits),
    cmdCompressed: num(r.cmdCompressed),
    summarized: num(r.summarized),
    textCompressed: num(r.textCompressed),
    byProvider: {},
  };
}

function toPeriod(raw: unknown): SavingsPeriod {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    usage: toUsagePeriod(r.usage),
    compression: toSmushPeriod(r.compression),
  };
}

function toSavingsResponse(raw: unknown): SavingsResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    today: toPeriod(r.today),
    month: toPeriod(r.month),
    lifetime: toPeriod(r.lifetime),
    smushEnabled: r.smushEnabled === true,
    cacheSize: num(r.cacheSize),
  };
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  if (n < 0.001) return "<$0.001";
  if (n >= 100) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(n >= 10 ? 2 : 3)}`;
}

function formatSavingsPeriod(label: string, period: SavingsPeriod, smushEnabled: boolean): string {
  const u = period.usage;
  if (u.requests === 0) return `${label}:\n  no data`;

  const totalTokens = u.inputTokens + u.outputTokens;
  const lines = [
    `${label}:`,
    `  ${fmtNum(u.requests)} requests \u00b7 ${fmtNum(totalTokens)} tokens (in: ${fmtNum(u.inputTokens)}, out: ${fmtNum(u.outputTokens)})`,
    `  \ud83d\udcb0 Cost avoided: ${fmtCost(u.estimatedCostAvoided)}`,
  ];

  if (smushEnabled) {
    const c = period.compression;
    if (c.tokensSaved > 0) {
      lines.push(`  \ud83d\udddc\ufe0f Compression: ~${fmtNum(c.tokensSaved)} tokens saved (${fmtCost(c.costSaved)})`);
    }
  }

  return lines.join("\n");
}

function formatSavingsStats(data: SavingsResponse): string {
  const sections = [
    "FFAI Usage & Savings",
    "\u2501".repeat(25),
    formatSavingsPeriod("Today", data.today, data.smushEnabled),
    "",
    formatSavingsPeriod("Last 30 days", data.month, data.smushEnabled),
    "",
    formatSavingsPeriod("Lifetime", data.lifetime, data.smushEnabled),
  ];

  const providers = Object.entries(data.lifetime.usage.byProvider)
    .filter(([, p]) => p.requests > 0)
    .sort((a, b) => b[1].estimatedCostAvoided - a[1].estimatedCostAvoided);

  if (providers.length > 0) {
    sections.push("");
    sections.push("Top providers:");
    for (const [name, p] of providers) {
      sections.push(`  ${name}: ${fmtNum(p.requests)} req \u00b7 ${fmtCost(p.estimatedCostAvoided)} saved`);
    }
  }

  return sections.join("\n");
}
