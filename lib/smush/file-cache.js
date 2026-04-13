/**
 * Smush file-cache — LRU hash-based deduplication of repeated file reads.
 *
 * Two-pass algorithm:
 *   Pass 1: Build tool_call → file path mapping, populate cache from ALL messages
 *   Pass 2: Replace OLD tool_result content with cache marker if hash unchanged
 *
 * Preserves last 2 messages untouched (active tool_use/tool_result pairs).
 */
"use strict";

const crypto = require("node:crypto");
const { extractText, setText } = require("./util.js");

const MIN_CACHE_BYTES = 50;
const CACHE_MARKER = (size) => `[File unchanged since last read — ${size} bytes cached]`;

// ── Tool detection ─────────────────────────────────────────────────────────

const READ_TOOL_NAMES = new Set([
  "read", "Read", "read_file", "ReadFile", "readfile",
  "cat", "View", "view", "read_document",
]);

function isReadTool(name) {
  return READ_TOOL_NAMES.has(name);
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  return toolInput.file_path || toolInput.path || toolInput.filePath || null;
}

// ── Hash ───────────────────────────────────────────────────────────────────

function hashContent(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// ── FileCache class ────────────────────────────────────────────────────────

class FileCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    /** @type {Map<string, {hash: string, size: number}>} */
    this.cache = new Map();
  }

  reset() {
    this.cache.clear();
  }

  /**
   * Look up a file in the cache.
   * Returns { hit: true, size } if hash matches, { hit: false } otherwise.
   * Always updates/inserts the entry.
   */
  check(filePath, text) {
    const hash = hashContent(text);
    const size = Buffer.byteLength(text, "utf8");
    const existing = this.cache.get(filePath);

    // Update LRU position (delete + re-set moves to end)
    if (existing) this.cache.delete(filePath);

    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }

    this.cache.set(filePath, { hash, size });

    if (existing && existing.hash === hash) {
      return { hit: true, size: existing.size };
    }
    return { hit: false };
  }

  /**
   * Process messages array in-place.
   * Returns { cacheHits, bytesSaved }.
   */
  process(messages) {
    const stats = { cacheHits: 0, bytesSaved: 0 };
    if (messages.length < 3) return stats;

    // ── Pass 1: Build tool_call_id → filePath mapping ──────────────────
    const toolCallPaths = new Map(); // tool_call_id → filePath

    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const calls = msg.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const fn = call.function;
        if (!fn || !isReadTool(fn.name)) continue;
        let args = fn.arguments;
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { continue; }
        }
        const filePath = extractFilePath(args);
        if (filePath && call.id) {
          toolCallPaths.set(call.id, filePath);
        }
      }
    }

    if (toolCallPaths.size === 0) return stats;

    // ── Pass 2: Scan ALL messages to populate cache, compress OLD ones ─
    const safeEnd = Math.max(0, messages.length - 2);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== "tool") continue;

      const filePath = toolCallPaths.get(msg.tool_call_id);
      if (!filePath) continue;

      const text = extractText(msg);
      if (!text || Buffer.byteLength(text, "utf8") < MIN_CACHE_BYTES) continue;

      const result = this.check(filePath, text);

      // Only replace content in OLD messages (before safeEnd)
      if (i < safeEnd && result.hit) {
        const originalSize = Buffer.byteLength(text, "utf8");
        const marker = CACHE_MARKER(result.size);
        setText(msg, marker);
        stats.cacheHits++;
        stats.bytesSaved += originalSize - Buffer.byteLength(marker, "utf8");
      }
    }

    return stats;
  }
}

module.exports = { FileCache };
