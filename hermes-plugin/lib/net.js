/**
 * Outbound-fetch hardening shared by discover.js and any future caller.
 *
 * Three layers:
 *   1. URL validation — reject non-http(s), embedded credentials, and
 *      query/hash. Forces operators to pass a clean base URL.
 *   2. Hostname allowlist — only the hostname of the configured base URL
 *      is reachable. A tampered relative path can't pivot to a different
 *      host.
 *   3. Metadata-endpoint blocklist — even when the configured base URL
 *      points at loopback / private network (the common FFAI install
 *      case), cloud metadata endpoints (`169.254.169.254`,
 *      `metadata.google.internal`, `metadata.azure.com`) are refused.
 *      This is the SSRF concern: a CLI run on a cloud VM where the
 *      operator's FFAI bridge has been hijacked must not become a
 *      credential-theft tool against the cloud's IMDS.
 *
 * The openclaw-plugin uses the SDK's `fetchWithSsrFGuard` which provides
 * a richer policy model. We don't have that SDK here, so we implement
 * the subset of checks that matter for a config-writer CLI.
 */
import { lookup as dnsLookup } from "node:dns/promises";

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.azure.com",
  "metadata",
]);

// Blocked IP literals — IMDSv1/v2 (AWS, GCP, Azure), link-local,
// and the AWS Lambda runtime API host. Anything in 169.254/16 is
// link-local and never a legitimate FFAI destination.
const BLOCKED_IP_PREFIXES = [
  "169.254.",     // link-local incl. IMDS 169.254.169.254
  "fd00:ec2::",   // AWS IPv6 IMDS
];

export class FfaiNetError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "FfaiNetError";
    this.code = code;
  }
}

/**
 * Parse and validate a candidate base URL. Returns the URL object or
 * throws FfaiNetError. Caller decides how to surface the error to the
 * user.
 */
export function parseBaseUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new FfaiNetError("baseUrl is required", "BASE_URL_MISSING");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FfaiNetError(`invalid baseUrl: ${raw}`, "BASE_URL_PARSE");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FfaiNetError(`baseUrl must be http(s): ${raw}`, "BASE_URL_SCHEME");
  }
  if (url.username || url.password) {
    throw new FfaiNetError("baseUrl must not contain credentials", "BASE_URL_CREDS");
  }
  if (url.search || url.hash) {
    throw new FfaiNetError("baseUrl must not contain query/hash", "BASE_URL_QUERY");
  }
  return url;
}

/**
 * Compose an endpoint URL pinned to the same protocol/host/port as the
 * configured base. Returns a string. `pathname` is treated as opaque —
 * caller is responsible for URL-encoding any user-controlled segments.
 */
export function buildEndpointUrl(baseUrl, pathname) {
  const parsed = parseBaseUrl(baseUrl);
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  const suffix = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${suffix}`;
}

function isBlockedIpLiteral(ip) {
  const lower = ip.toLowerCase();
  for (const prefix of BLOCKED_IP_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Refuse cloud metadata endpoints. Resolves the URL's hostname via DNS
 * and rejects any address in the blocklist — so a CNAME pointing at
 * `169.254.169.254` doesn't slip through.
 *
 * Throws FfaiNetError on rejection; resolves to the parsed URL on pass.
 */
export async function assertNotMetadataEndpoint(url) {
  const parsed = typeof url === "string" ? parseBaseUrl(url) : url;
  const hostname = parsed.hostname.toLowerCase();

  if (METADATA_HOSTS.has(hostname)) {
    throw new FfaiNetError(`refusing to fetch cloud metadata host: ${hostname}`, "BLOCKED_METADATA_HOST");
  }
  if (isBlockedIpLiteral(hostname)) {
    throw new FfaiNetError(`refusing to fetch blocked IP: ${hostname}`, "BLOCKED_IP");
  }

  // DNS-resolve. A hostname that looks innocuous (e.g. evil.example.com)
  // may have an A record pointing at 169.254.169.254 — catch that here.
  // Skip when the hostname is already an IP literal (no resolution needed).
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return parsed;

  try {
    const records = await dnsLookup(hostname, { all: true });
    for (const rec of records) {
      if (isBlockedIpLiteral(rec.address)) {
        throw new FfaiNetError(
          `refusing to fetch ${hostname} — resolves to blocked address ${rec.address}`,
          "BLOCKED_IP_RESOLVED",
        );
      }
    }
  } catch (err) {
    // DNS failure: let the actual fetch surface the error rather than
    // pretending we know — but rethrow our own blocks.
    if (err instanceof FfaiNetError) throw err;
  }

  return parsed;
}

/**
 * Read at most `maxBytes` of an HTTP response body as text. Bounds memory
 * so a malicious / misconfigured FFAI server can't OOM the CLI by
 * returning a giant body.
 */
export async function readBoundedText(response, maxBytes) {
  const lenHeader = response.headers.get("content-length");
  if (lenHeader) {
    const len = Number(lenHeader);
    if (Number.isFinite(len) && len > maxBytes) {
      throw new FfaiNetError(`response body too large (${len} > ${maxBytes} bytes)`, "BODY_TOO_LARGE");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) return await response.text();
  const chunks = [];
  let received = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw new FfaiNetError(`response body too large (>${maxBytes} bytes)`, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return new TextDecoder("utf-8").decode(merged);
}
