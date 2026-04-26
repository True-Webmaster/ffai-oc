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
import { buildFfaiSsrfPolicy } from "./models.js";

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

  return ffaiRequest(
    {
      url: `${baseUrl}/savings`,
      init: {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      },
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

  return ffaiRequest(
    {
      url: `${baseUrl}/generate-import`,
      init: {
        headers: { Authorization: `Bearer ${adminKey}`, Accept: "text/html" },
        signal: AbortSignal.timeout(15_000),
      },
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

  // Require the explicit FFAI-IMPORT: prefix. The previous base64-prefix
  // heuristic (`/^eyJ/`) was ambiguous and happy to promote any base64 JSON
  // to an import attempt, which widened the attack surface of this command.
  if (!raw.startsWith("FFAI-IMPORT:")) {
    return {
      text: "Invalid import blob. It must start with FFAI-IMPORT: (regenerate via /ffai_encrypt).",
      isError: true,
    };
  }
  const blob = raw;

  return ffaiRequest(
    {
      url: `${baseUrl}/import`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ payload: blob }),
        signal: AbortSignal.timeout(15_000),
      },
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

      if (data.error) {
        const errMsg = redactSecrets(String(data.error)).slice(0, 600);
        return { text: `FFAI /import error: ${errMsg}`, isError: true };
      }

      const imported = typeof data.imported === "number" ? data.imported : 0;
      const duplicates = typeof data.duplicates === "number" ? data.duplicates : 0;
      const invalid = typeof data.invalid === "number" ? data.invalid : 0;
      const mismatched = typeof data.mismatched === "number" ? data.mismatched : 0;
      const provider = typeof data.provider === "string" && data.provider.trim()
        ? data.provider.trim()
        : "unknown";

      if (imported === 0) {
        const msg = typeof data.message === "string" ? data.message : "no keys imported";
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
        ? `\n\nNote: ${data.restart_hint}`
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
      detail: `present (${apiKey.length} chars)`,
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
      detail: `present (${adminKey.length} chars)`,
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
      checks.push({
        name: "FFAI reachable",
        status: "fail",
        detail: `${baseUrl} unreachable (${providersResult.reason})`,
        remediation:
          `Verify FFAI is running and bound to ${new URL(baseUrl).host}. ` +
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
      const prov = (cfg?.models?.providers as Record<string, unknown>)?.[provKey] as
        { models?: Array<{ id?: unknown }> } | undefined;
      const models = Array.isArray(prov?.models) ? prov.models : [];
      for (const m of models) {
        const id = typeof m === "object" && m && "id" in m && typeof (m as { id: unknown }).id === "string"
          ? (m as { id: string }).id
          : null;
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

async function probeFfaiProviders(params: { baseUrl: string; apiKey: string }): Promise<
  | { ok: true; providers: string[]; providerDetails: Record<string, { total: number }> }
  | { ok: false; reason: string }
> {
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url: `${params.baseUrl}/providers`,
      init: {
        headers: { Authorization: `Bearer ${params.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
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
    return { ok: false, reason: describe(err) };
  } finally {
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

async function probeFfaiModels(params: { baseUrl: string; apiKey: string }): Promise<
  | { ok: true; modelCount: number }
  | { ok: false; reason: string }
> {
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url: `${params.baseUrl}/models`,
      init: {
        headers: { Authorization: `Bearer ${params.apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
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
    return { ok: false, reason: describe(err) };
  } finally {
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
  params: { url: string; init: RequestInit; baseUrl: string; audit: string },
  consume: (response: Response) => Promise<CommandResult>,
): Promise<CommandResult> {
  let release: (() => Promise<void> | void) | undefined;
  try {
    const result = await fetchWithSsrFGuard({
      url: params.url,
      init: params.init,
      policy: buildFfaiSsrfPolicy(params.baseUrl),
      auditContext: params.audit,
    });
    release = result.release;
    const response = result.response;

    if (!response.ok) {
      const body = await safeReadBody(response);
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
    if (release) {
      try { await release(); } catch { /* release failure is not actionable */ }
    }
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk-[A-Za-z0-9_-]{10,})/g,
  /\b(?:gsk_[A-Za-z0-9_-]{10,})/g,
  /\b(?:csk-[A-Za-z0-9_-]{10,})/g,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,                   // AWS access key IDs
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\/\/[^@\s]+:[^@\s]+@/g,                   // URL-embedded user:pass@
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
