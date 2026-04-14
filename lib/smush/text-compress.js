/**
 * Smush general-purpose text compression — the missing pipeline.
 *
 * Ported from AISmush compress.rs: content type detection → comment stripping →
 * whitespace normalization → windowed line dedup → size caps.
 *
 * This runs on ALL tool output that wasn't handled by cmd-compress or summarize.
 */
"use strict";

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_CODE_CHARS = 12000;
const MAX_DATA_CHARS = 12000;
const MAX_LOG_CHARS = 8000;
const DEDUP_WINDOW = 10;
const DEDUP_MIN_LEN = 15;
const MIN_COMPRESSION_RATIO = 0.10; // don't use if < 10% of original

// ── Content type detection ─────────────────────────────────────────────────

function detectContentType(text) {
  const lines = text.split("\n");
  const first20 = lines.slice(0, 20).join("\n");
  const trimmedStart = text.trimStart();

  // JSON / structured data
  if (/^[\[{]/.test(trimmedStart)) return "data";

  // YAML
  if (trimmedStart.startsWith("---") || /^[a-zA-Z_]\w*:\s/.test(trimmedStart)) {
    if (!trimmedStart.includes("//") && !trimmedStart.includes("fn ")) return "data";
  }

  // XML / HTML
  if (/^<(\?xml|!DOCTYPE|html)/i.test(trimmedStart)) return "data";

  // Log output: 3+ lines with log markers or stack traces
  let logLineCount = 0;
  for (const line of lines.slice(0, 30)) {
    if (/\[(INFO|WARN|ERROR|DEBUG|TRACE)\]|^\d{4}-\d{2}-\d{2}[T ]|^at\s+\S+\s+\(/.test(line)) {
      logLineCount++;
    }
  }
  if (logLineCount >= 3) return "log";

  // Code: 2+ lines with language keywords
  let codeLineCount = 0;
  for (const line of lines.slice(0, 20)) {
    if (/\b(fn |import |export |def |class |function |struct |enum |trait |interface |const |let |var |pub |use |from |require\(|module\.exports)\b/.test(line)) {
      codeLineCount++;
    }
  }
  if (codeLineCount >= 2) return "code";

  return "unknown";
}

// ── Comment stripping ──────────────────────────────────────────────────────

function stripComments(text) {
  const lines = text.split("\n");
  const out = [];
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Block comment tracking
    if (inBlockComment) {
      const endIdx = trimmed.indexOf("*/");
      if (endIdx !== -1) {
        inBlockComment = false;
        const afterBlock = trimmed.slice(endIdx + 2).trim();
        if (afterBlock) out.push(afterBlock);
      }
      continue;
    }

    // Start of block comment
    if (trimmed.startsWith("/*")) {
      // Check if it closes on the same line
      const endIdx = trimmed.indexOf("*/", 2);
      if (endIdx !== -1) {
        const afterBlock = trimmed.slice(endIdx + 2).trim();
        if (afterBlock) out.push(afterBlock);
      } else {
        inBlockComment = true;
      }
      continue;
    }

    // Skip pure line comments (but preserve shebangs, macros, doc comments)
    if (trimmed.startsWith("//")) {
      // Preserve: doc comments (///), Rust attributes
      if (trimmed.startsWith("///") || trimmed.startsWith("//!")) {
        out.push(line);
      }
      continue;
    }
    if (trimmed.startsWith("#") && !trimmed.startsWith("#!") && !trimmed.startsWith("#[")) {
      // Skip Python/shell comments, but not shebangs or Rust attributes
      continue;
    }
    if (trimmed.startsWith("--") && !trimmed.startsWith("---")) {
      // Skip SQL/Lua comments, but not YAML doc separators
      continue;
    }

    // Keep empty lines and code lines
    out.push(line);
  }

  return out.join("\n");
}

// ── Whitespace normalization ───────────────────────────────────────────────

function normalizeWhitespace(text) {
  const lines = text.split("\n");
  const out = [];
  let consecutiveBlank = 0;
  let consecutiveClosing = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Cap consecutive blank lines at 1
    if (!trimmed) {
      if (consecutiveBlank < 1) out.push("");
      consecutiveBlank++;
      consecutiveClosing = 0;
      continue;
    }
    consecutiveBlank = 0;

    // Cap consecutive closing brackets at 2
    if (/^[}\]);,]*$/.test(trimmed)) {
      consecutiveClosing++;
      if (consecutiveClosing > 2) continue;
    } else {
      consecutiveClosing = 0;
    }

    // Halve indentation (8-space → 4-space)
    const leadingMatch = line.match(/^(\s+)/);
    if (leadingMatch) {
      const indent = leadingMatch[1];
      const spaces = indent.replace(/\t/g, "    ").length;
      const halved = " ".repeat(Math.ceil(spaces / 2));
      out.push(halved + trimmed);
    } else {
      out.push(trimmed);
    }
  }

  // Remove trailing empty lines
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();

  return out.join("\n");
}

// ── Windowed line deduplication ────────────────────────────────────────────

function dedupLines(text) {
  const lines = text.split("\n");
  const out = [];
  const window = new Map(); // normalized → count in window
  const windowQueue = []; // ordered list of recent normalized lines

  for (const line of lines) {
    const trimmed = line.trim();

    // Short lines always kept
    if (trimmed.length < DEDUP_MIN_LEN) {
      out.push(line);
      continue;
    }

    const normalized = trimmed.toLowerCase();

    // Check if in window
    if (window.has(normalized)) {
      window.set(normalized, (window.get(normalized) || 0) + 1);
      // Don't push to output — it's a dup within the window
      continue;
    }

    // Flush any accumulated dups from previous line
    // (handled below by checking window counts)

    // Evict from window if at capacity
    while (windowQueue.length >= DEDUP_WINDOW) {
      const evicted = windowQueue.shift();
      const count = window.get(evicted) || 0;
      if (count > 1) {
        out.push(`[... ${count} similar lines omitted]`);
      }
      window.delete(evicted);
    }

    // Add to window
    window.set(normalized, 1);
    windowQueue.push(normalized);
    out.push(line);
  }

  // Flush remaining window entries with dups
  for (const norm of windowQueue) {
    const count = window.get(norm) || 0;
    if (count > 1) {
      out.push(`[... ${count} similar lines omitted]`);
    }
  }

  return out.join("\n");
}

// ── Smart code truncation (preserves signatures) ───────────────────────────

const IMPORTANT_RE = /^\s*(fn |pub |use |import |from |export |class |def |function |struct |enum |trait |interface |type |const |let |module)/;
const BRACE_RE = /^[{}]\s*$/;

function smartTruncateCode(text, maxChars) {
  if (text.length <= maxChars) return text;

  const lines = text.split("\n");
  const out = [];
  let charCount = 0;
  const halfMax = maxChars / 2;
  let totalLines = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Always include first 50% of budget
    if (charCount < halfMax) {
      out.push(line);
      charCount += line.length + 1;
      continue;
    }

    // After 50%, only include important lines
    const isImportant = IMPORTANT_RE.test(line) || BRACE_RE.test(line.trim());
    if (isImportant) {
      out.push(line);
      charCount += line.length + 1;
      continue;
    }

    // Stop if over budget and not important
    if (charCount >= maxChars) {
      out.push(`[... ${totalLines - i} more lines, ${totalLines} total]`);
      break;
    }

    out.push(line);
    charCount += line.length + 1;
  }

  return out.join("\n");
}

// ── Smart data truncation ──────────────────────────────────────────────────

function smartTruncateData(text, maxChars) {
  if (text.length <= maxChars) return text;

  // Find safe boundary at last newline before maxChars
  let cutoff = maxChars;
  const lastNewline = text.lastIndexOf("\n", cutoff);
  if (lastNewline > 0) cutoff = lastNewline;

  return text.slice(0, cutoff) + `\n[... ${text.length} total chars, showing first ${cutoff}]`;
}

// ── Main compress_text pipeline ────────────────────────────────────────────

/**
 * General-purpose text compression. Applies comment stripping, whitespace
 * normalization, dedup, and size caps based on content type.
 *
 * @param {string} text - Raw text content
 * @returns {{ text: string, compressed: boolean }}
 */
function compressText(text) {
  if (!text || text.length < 200) return { text, compressed: false };

  const contentType = detectContentType(text);
  let result;

  switch (contentType) {
    case "code": {
      result = stripComments(text);
      result = normalizeWhitespace(result);
      result = dedupLines(result);
      if (result.length > MAX_CODE_CHARS) result = smartTruncateCode(result, MAX_CODE_CHARS);
      break;
    }
    case "data": {
      // Never strip comments from data formats
      if (text.length > MAX_DATA_CHARS) {
        result = smartTruncateData(text, MAX_DATA_CHARS);
      } else {
        return { text, compressed: false };
      }
      break;
    }
    case "log": {
      result = normalizeWhitespace(text);
      result = dedupLines(result);
      if (result.length > MAX_LOG_CHARS) result = smartTruncateData(result, MAX_LOG_CHARS);
      break;
    }
    default: { // unknown
      result = normalizeWhitespace(text);
      result = dedupLines(result);
      if (result.length > MAX_CODE_CHARS) result = smartTruncateData(result, MAX_CODE_CHARS);
      break;
    }
  }

  // Safety floor: don't use if < 10% of original remains
  if (result.length > 0 && result.length / text.length < MIN_COMPRESSION_RATIO) {
    return { text, compressed: false };
  }

  // Safety ceiling: don't use if < 20% saved
  if (result.length >= text.length * 0.8) {
    return { text, compressed: false };
  }

  return { text: result, compressed: true };
}

module.exports = { compressText };
