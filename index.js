/**
 * FFAI Engine — Public API
 *
 * Importable library for key pooling and rotation.
 *
 *   const { Pool } = require("ffai-engine");
 *
 * @example
 *   const { Pool, Provider, KeyScorer, SlidingWindow } = require("ffai-engine");
 *
 *   const pool = new Pool({
 *     providers: {
 *       gemini: {
 *         keys: ["key1", "key2"],
 *         rpm_limit: 15,
 *         tpm_limit: 1000000,
 *       },
 *     },
 *     statsFile: "./data/stats.json",
 *   });
 *
 *   // Acquire a key
 *   const handle = pool.acquire("gemini");
 *   if (handle) {
 *     try {
 *       const response = await callGeminiAPI(handle.key, request);
 *       pool.release("gemini", handle.key, {
 *         success: true,
 *         inputTokens: 500,
 *         outputTokens: response.usage.completion_tokens,
 *       });
 *     } catch (err) {
 *       pool.release("gemini", handle.key, {
 *         success: false,
 *         statusCode: err.status || 500,
 *         retryAfter: err.retryAfter,
 *       });
 *     }
 *   }
 */

const Pool = require("./lib/pool");
const Provider = require("./lib/provider");
const Alerter = require("./lib/alerter");
const KeyScorer = require("./lib/key-scorer");
const SlidingWindow = require("./lib/sliding-window");
const Stats = require("./lib/stats");
const AuthGuard = require("./lib/auth-guard");
const LatencyTracker = require("./lib/latency-tracker");
const { sanitize, withRetry, ALLOWED_FIELDS } = require("./lib/sanitizer");
const utils = require("./lib/utils");

module.exports = {
  Pool,
  Provider,
  Alerter,
  KeyScorer,
  SlidingWindow,
  Stats,
  AuthGuard,
  LatencyTracker,
  sanitize,
  withRetry,
  ALLOWED_FIELDS,
  ...utils,
};
