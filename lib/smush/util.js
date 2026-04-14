/**
 * Smush shared utilities — text extraction, ANSI stripping, stats.
 */
"use strict";

// ── ANSI escape stripping ──────────────────────────────────────────────────

const ANSI_RE = /\x1B(?:\[[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\))/g;

function stripAnsi(str) {
  return str.replace(ANSI_RE, "");
}

// ── Progress bar / spinner stripping ───────────────────────────────────────

const PROGRESS_RE = /^[\s[\]|=>#.\-─━░█▓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\\s]{10,}\d+%/;
const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
const CARRIAGE_RE = /\r[^\n]/;

function isProgressLine(line) {
  return PROGRESS_RE.test(line) || (SPINNER_CHARS.test(line) && line.length < 80) || CARRIAGE_RE.test(line);
}

function stripProgressLines(text) {
  return text.split("\n").filter((l) => !isProgressLine(l)).join("\n");
}

// ── Message text extraction / setting ──────────────────────────────────────
// Handles both string content and array content [{type:"text",text:"..."}, ...]

function extractText(message) {
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.filter((p) => p.type === "text" && p.text);
    return parts.map((p) => p.text).join("\n");
  }
  return "";
}

function setText(message, newText) {
  const c = message.content;
  if (typeof c === "string") {
    message.content = newText;
    return;
  }
  if (Array.isArray(c)) {
    const textPart = c.find((p) => p.type === "text");
    if (textPart) {
      textPart.text = newText;
    } else {
      c.unshift({ type: "text", text: newText });
    }
  }
}

// ── Stats ──────────────────────────────────────────────────────────────────

function createStats() {
  return {
    cacheHits: 0,
    cacheMisses: 0,
    cmdCompressed: 0,
    summarized: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
}

module.exports = {
  stripAnsi,
  stripProgressLines,
  extractText,
  setText,
  createStats,
};
