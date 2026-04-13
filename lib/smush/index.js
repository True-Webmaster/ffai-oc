/**
 * Smush — FFAI token compression middleware.
 *
 * Reduces input tokens on OpenAI-compatible chat completion requests via:
 *   1. File cache — dedup repeated file reads (LRU hash-based)
 *   2. Cmd compress — strip CLI output noise (test, build, git, npm, docker)
 *   3. Summarize — structural outlines for old large code blocks
 *
 * Usage:
 *   const { smush, resetSmush } = require("./lib/smush");
 *   body = smush(body, config);       // in handleProxy, after readBody
 *   resetSmush();                     // on SIGHUP to clear file cache
 */
"use strict";

const { FileCache } = require("./file-cache.js");
const { compressCmdOutput } = require("./cmd-compress.js");
const { summarizeCode } = require("./summarize.js");
const { compressText } = require("./text-compress.js");
const { extractText, setText, createStats } = require("./util.js");

// ── Module-level state ─────────────────────────────────────────────────────

const fileCache = new FileCache(500);
let totalStats = { requests: 0, bytesSaved: 0, cacheHits: 0, cmdCompressed: 0, summarized: 0, textCompressed: 0 };

// ── Main entry ─────────────────────────────────────────────────────────────

/**
 * Compress a chat completions request body.
 * @param {Buffer} bodyBuffer - Raw request body
 * @param {object} config - FFAI config with smush section
 * @returns {{ buffer: Buffer, stats: object|null }} Compressed body + per-request stats (null if no compression)
 */
function smush(bodyBuffer, config) {
  const cfg = config?.smush;
  if (!cfg?.enabled) return { buffer: bodyBuffer, stats: null };

  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString());
  } catch {
    return { buffer: bodyBuffer, stats: null };
  }

  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return { buffer: bodyBuffer, stats: null };
  }

  const stats = createStats();
  stats.bytesBefore = bodyBuffer.length;

  const messages = parsed.messages;

  // ── 1. File cache (skip last 2) ──────────────────────────────────────
  if (cfg.fileCache !== false) {
    const cacheStats = fileCache.process(messages);
    stats.cacheHits = cacheStats.cacheHits;
  }

  // ── 2 & 3. Cmd compress + Summarize (skip last 4) ───────────────────
  const safeEnd = Math.max(0, messages.length - 4);

  for (let i = 0; i < safeEnd; i++) {
    const msg = messages[i];

    // Only compress tool results and user messages
    if (msg.role !== "tool" && msg.role !== "user") continue;

    // Skip error tool results — LLM needs full error context
    if (msg.role === "tool" && msg.is_error) continue;

    const text = extractText(msg);
    if (!text || text.length < 200) continue;

    // Try cmd compress first (cheaper, more specific)
    if (cfg.cmdCompress !== false) {
      const result = compressCmdOutput(text);
      if (result.compressed) {
        setText(msg, result.text);
        stats.cmdCompressed++;
        continue; // Don't also summarize
      }
    }

    // Try code summarization
    if (cfg.summarize !== false) {
      const threshold = cfg.summaryThreshold || 4000;
      const result = summarizeCode(text, threshold);
      if (result.summarized) {
        setText(msg, result.text);
        stats.summarized++;
        continue;
      }
    }

    // Fallback: general-purpose text compression (comment strip, whitespace, dedup, caps)
    const textResult = compressText(text);
    if (textResult.compressed) {
      setText(msg, textResult.text);
      stats.textCompressed++;
    }
  }

  // ── Serialize and measure ────────────────────────────────────────────
  const out = Buffer.from(JSON.stringify(parsed));
  stats.bytesAfter = out.length;

  const saved = stats.bytesBefore - stats.bytesAfter;
  if (saved <= 0) return { buffer: bodyBuffer, stats: null }; // No gain, return original

  // Update totals
  totalStats.requests++;
  totalStats.bytesSaved += saved;
  totalStats.cacheHits += stats.cacheHits;
  totalStats.cmdCompressed += stats.cmdCompressed;
  totalStats.summarized += stats.summarized;
  totalStats.textCompressed += stats.textCompressed || 0;

  const requestStats = {
    bytesBefore: stats.bytesBefore,
    bytesAfter: stats.bytesAfter,
    bytesSaved: saved,
    tokensSaved: Math.ceil(saved / 4), // ~4 chars per token
    ratio: saved / stats.bytesBefore,
    cacheHits: stats.cacheHits,
    cmdCompressed: stats.cmdCompressed,
    summarized: stats.summarized,
    textCompressed: stats.textCompressed || 0,
  };

  if (cfg.verbose) {
    const ratio = (requestStats.ratio * 100).toFixed(1);
    console.log(
      `[smush] ${(saved / 1024).toFixed(1)}KB saved (${ratio}%) ~${requestStats.tokensSaved} tokens | ` +
      `cache:${stats.cacheHits} cmd:${stats.cmdCompressed} sum:${stats.summarized} txt:${stats.textCompressed || 0}`
    );
  }

  return { buffer: out, stats: requestStats };
}

/**
 * Reset file cache and stats (call on SIGHUP).
 */
function resetSmush() {
  fileCache.reset();
  totalStats = { requests: 0, bytesSaved: 0, cacheHits: 0, cmdCompressed: 0, summarized: 0, textCompressed: 0 };
}

/**
 * Get cumulative stats.
 */
function getSmushStats() {
  return { ...totalStats, cacheSize: fileCache.cache.size };
}

module.exports = { smush, resetSmush, getSmushStats };
