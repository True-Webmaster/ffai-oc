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
    return { text: "FFAI_KEY not configured. Cannot fetch stats.", isError: true };
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
      text: "FFAI_ADMIN_KEY not configured. Set it in your environment to generate import pages.",
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
        const errMsg = redactSecrets(String(data.error)).slice(0, 300);
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
      return {
        text: `Keys imported successfully! ${imported} key(s) added for provider "${provider}"${suffix}.`,
      };
    },
  );
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
