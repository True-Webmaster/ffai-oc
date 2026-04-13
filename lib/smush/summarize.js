/**
 * Smush structural code summarizer — replaces large code blocks with
 * import/type/function signature outlines.
 *
 * Language support: TypeScript/JavaScript, Rust, Python, Go, generic fallback.
 */
"use strict";

const DEFAULT_THRESHOLD = 4000; // bytes
const MAX_SUMMARY_CHARS = 2048;

// ── Language detection ─────────────────────────────────────────────────────

function detectLanguage(text) {
  const sample = text.split("\n").slice(0, 30).join("\n");

  if (/\buse crate::/.test(sample) || (/\bfn\s/.test(sample) && /->/.test(sample)) ||
      /\bpub struct\s/.test(sample) || /\bimpl\s/.test(sample))
    return "rust";

  if (/\bimport\s.+from\s['"]/.test(sample) || /\bexport\s/.test(sample) ||
      /:\s*React\.FC/.test(sample) || /\binterface\s/.test(sample) ||
      /\bconst\s.+=\s*require\(/.test(sample))
    return "typescript";

  if (/\bdef\s\w+\(.*\):/.test(sample) || (/\bimport\s/.test(sample) && /\b__\w+__/.test(sample)) ||
      /\bself\./.test(sample))
    return "python";

  if ((/\bfunc\s/.test(sample) && /\bpackage\s/.test(sample)) ||
      (/\bpackage\s/.test(sample) && /\bimport\s*\(/.test(sample)))
    return "go";

  return "generic";
}

// ── TypeScript/JavaScript extractor ────────────────────────────────────────

const TS_IMPORT_RE = /^(?:import\s|const\s+\w+\s*=\s*require\()/;
const TS_REEXPORT_RE = /^export\s.+\sfrom\s/;
const TS_TYPE_RE = /^(?:export\s+)?(?:interface|type|enum)\s/;
const TS_FUNC_RE = /^(?:export\s+)?(?:(?:default\s+)?(?:async\s+)?function|(?:abstract\s+)?class)\s/;
const TS_ARROW_RE = /^export\s+(?:const|let)\s+\w+\s*=\s*(?:async\s*)?\(/;

function extractTypeScript(lines) {
  const imports = [], types = [], functions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue;

    if (TS_IMPORT_RE.test(trimmed) || TS_REEXPORT_RE.test(trimmed)) {
      imports.push(trimmed);
      continue;
    }
    if (TS_TYPE_RE.test(trimmed)) {
      const sig = trimmed.replace(/\{.*$/, "{ ... }").replace(/\s+$/, "");
      types.push(sig);
      continue;
    }
    if (TS_FUNC_RE.test(trimmed)) {
      const sig = trimmed.replace(/\{.*$/, "{ ... }").replace(/\s+$/, "");
      functions.push(sig);
      continue;
    }
    if (TS_ARROW_RE.test(trimmed)) {
      const sig = trimmed.replace(/\{.*$/, "{ ... }").replace(/=>.*$/, "=> ...").replace(/\s+$/, "");
      functions.push(sig);
    }
  }

  return { imports, types, functions };
}

// ── Rust extractor ─────────────────────────────────────────────────────────

const RS_USE_RE = /^(?:pub\s+)?use\s/;
const RS_MOD_RE = /^(?:pub\s+)?mod\s/;
const RS_TYPE_RE = /^(?:pub(?:\(.+?\)\s+)?)?(?:struct|enum|trait|type)\s/;
const RS_IMPL_RE = /^impl(?:<|\s)/;
const RS_FN_RE = /^(?:pub(?:\(.+?\)\s+)?)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s/;

function extractRust(lines) {
  const imports = [], types = [], functions = [], modules = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (RS_USE_RE.test(trimmed)) { imports.push(trimmed); continue; }
    if (RS_MOD_RE.test(trimmed)) {
      // Only include file-level mod declarations (with semicolon), not inline mod blocks
      if (trimmed.endsWith(";")) modules.push(trimmed);
      continue;
    }
    if (RS_TYPE_RE.test(trimmed)) {
      types.push(trimmed.replace(/\{.*$/, "{ ... }").replace(/\bwhere\b.*$/, "where ..."));
      continue;
    }
    if (RS_IMPL_RE.test(trimmed)) {
      types.push(trimmed.replace(/\{.*$/, "{ ... }"));
      continue;
    }
    if (RS_FN_RE.test(trimmed)) {
      functions.push(trimmed.replace(/\{.*$/, "{ ... }"));
      continue;
    }
  }

  return { imports, types, functions, modules };
}

// ── Python extractor ───────────────────────────────────────────────────────

function extractPython(lines) {
  const imports = [], types = [], functions = [];
  let decorator = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("import ") || trimmed.startsWith("from ")) {
      imports.push(trimmed);
      continue;
    }

    if (trimmed.startsWith("@")) {
      decorator = trimmed;
      continue;
    }

    // Top-level class
    if (/^class\s/.test(trimmed) && trimmed.endsWith(":")) {
      const entry = decorator ? `${decorator}\n${trimmed}` : trimmed;
      types.push(entry);
      decorator = null;
      continue;
    }

    // Functions (top-level or method)
    if (/^(?:async\s+)?def\s/.test(trimmed) || /^\s{1,8}(?:async\s+)?def\s/.test(line)) {
      const sig = trimmed.endsWith(":") ? trimmed : trimmed.replace(/:.*$/, ":");
      const entry = decorator ? `${decorator}\n${sig}` : sig;
      functions.push(entry);
      decorator = null;
      continue;
    }

    decorator = null;
  }

  return { imports, types, functions };
}

// ── Go extractor ───────────────────────────────────────────────────────────

function extractGo(lines) {
  const imports = [], types = [], functions = [];
  let inImportBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (trimmed === "import (") { inImportBlock = true; imports.push(trimmed); continue; }
    if (inImportBlock) {
      imports.push(trimmed);
      if (trimmed === ")") inImportBlock = false;
      continue;
    }
    if (trimmed.startsWith("import ")) { imports.push(trimmed); continue; }

    if (/^type\s/.test(trimmed)) {
      types.push(trimmed.replace(/\{.*$/, "{ ... }"));
      continue;
    }
    if (/^func\s/.test(trimmed)) {
      functions.push(trimmed.replace(/\{.*$/, "{ ... }"));
      continue;
    }
  }

  return { imports, types, functions };
}

// ── Generic extractor ──────────────────────────────────────────────────────

const GENERIC_KEYWORDS = /^(?:import|use|from|export|fn|pub fn|def|async def|func|function|class|struct|enum|trait|interface|type|const|let|module)\s/;

function extractGeneric(lines) {
  const imports = [], functions = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (GENERIC_KEYWORDS.test(trimmed)) {
      if (/^(?:import|use|from|require)\s/.test(trimmed)) {
        imports.push(trimmed);
      } else {
        functions.push(trimmed.replace(/\{.*$/, "{ ... }"));
      }
    }
  }

  return { imports, types: [], functions };
}

// ── Format summary output ──────────────────────────────────────────────────

function formatSummary(lang, originalLines, extracted) {
  const sections = [];

  if (extracted.imports?.length) {
    sections.push("// Imports:");
    sections.push(...extracted.imports);
  }
  if (extracted.modules?.length) {
    sections.push("// Modules:");
    sections.push(...extracted.modules);
  }
  if (extracted.types?.length) {
    sections.push("// Types:");
    sections.push(...extracted.types);
  }
  if (extracted.functions?.length) {
    sections.push("// Functions:");
    sections.push(...extracted.functions);
  }

  if (sections.length === 0) return null;

  const totalExtracted = sections.length;
  let body = sections.join("\n");

  // Cap at MAX_SUMMARY_CHARS
  if (body.length > MAX_SUMMARY_CHARS) {
    const idx = body.lastIndexOf("\n", MAX_SUMMARY_CHARS);
    body = body.slice(0, idx > 0 ? idx : MAX_SUMMARY_CHARS) + "\n[... summary truncated]";
  }

  return `[Structural summary of ${lang} code (${originalLines} lines → ${totalExtracted} lines)]\n${body}`;
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Summarize a large code block into structural outline.
 * @param {string} text - Code text
 * @param {number} [threshold] - Minimum byte size to trigger summarization
 * @returns {{ text: string, summarized: boolean }}
 */
function summarizeCode(text, threshold = DEFAULT_THRESHOLD) {
  if (!text || Buffer.byteLength(text, "utf8") < threshold) {
    return { text, summarized: false };
  }

  // Don't summarize data formats
  const firstChars = text.trim().slice(0, 5);
  if (firstChars.startsWith("{") || firstChars.startsWith("[") ||
      firstChars.startsWith("---") || firstChars.startsWith("<?xml") ||
      firstChars.startsWith("<!DOC")) {
    return { text, summarized: false };
  }

  // Don't summarize error content
  if (/\b(error|Error|ERROR|panic|Panic|PANIC|traceback|Traceback)\b/.test(text.slice(0, 500))) {
    return { text, summarized: false };
  }

  const lang = detectLanguage(text);
  const lines = text.split("\n");
  let extracted;

  switch (lang) {
    case "typescript": extracted = extractTypeScript(lines); break;
    case "rust": extracted = extractRust(lines); break;
    case "python": extracted = extractPython(lines); break;
    case "go": extracted = extractGo(lines); break;
    default: extracted = extractGeneric(lines); break;
  }

  const summary = formatSummary(lang, lines.length, extracted);
  if (!summary) return { text, summarized: false };

  // Gate: only use if summary < 50% of original
  if (Buffer.byteLength(summary, "utf8") >= Buffer.byteLength(text, "utf8") * 0.5) {
    return { text, summarized: false };
  }

  return { text: summary, summarized: true };
}

module.exports = { summarizeCode, detectLanguage };
