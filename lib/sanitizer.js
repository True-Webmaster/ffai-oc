/**
 * Sanitizer — OpenAI-compat request body sanitization.
 *
 * Strips non-standard fields, normalizes token limits, and caps output
 * tokens per provider config. Ensures clean requests reach upstream APIs.
 *
 * OpenAI-compat request body sanitization.
 */

// Fields allowed in an OpenAI-compat chat completion request
const ALLOWED_FIELDS = new Set([
  "model", "messages", "stream", "temperature", "top_p", "n",
  "max_tokens", "max_completion_tokens", "stop", "presence_penalty",
  "frequency_penalty", "logit_bias", "user", "tools", "tool_choice",
  "response_format", "seed", "logprobs", "top_logprobs",
  "stream_options", "store", "metadata", "parallel_tool_calls",
]);

// Per-provider fields to additionally strip (beyond the global ALLOWED_FIELDS filter).
// Keys are provider names or family names; values are Sets of field names to remove.
const PROVIDER_STRIP = {
  gemini: new Set(["parallel_tool_calls", "logit_bias", "logprobs", "top_logprobs", "store", "metadata"]),
  google: new Set(["parallel_tool_calls", "logit_bias", "logprobs", "top_logprobs", "store", "metadata"]),
  groq:     new Set(["logit_bias", "logprobs", "top_logprobs", "parallel_tool_calls", "store", "metadata"]),
  ollama:   new Set(["logit_bias", "logprobs", "top_logprobs", "parallel_tool_calls", "store", "metadata"]),
  cerebras: new Set(["logit_bias", "logprobs", "top_logprobs", "parallel_tool_calls", "store", "metadata"]),
};

/**
 * Sanitize an OpenAI-compat chat completion request body.
 *
 * @param {string|Buffer} rawBody    - Raw request body
 * @param {object}        [opts]
 * @param {number}        [opts.maxOutputTokens] - Cap for max_tokens (0 = no cap)
 * @returns {{ body: string, modified: boolean, parsed: object|null }}
 */
function sanitize(rawBody, opts = {}) {
  const maxOutputTokens = opts.maxOutputTokens || 0;
  const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString();

  let parsed;
  try {
    parsed = JSON.parse(bodyStr);
  } catch {
    return { body: bodyStr, modified: false, parsed: null };
  }

  if (!parsed || typeof parsed !== "object") {
    return { body: bodyStr, modified: false, parsed: null };
  }

  let modified = false;

  // Strip non-standard fields
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_FIELDS.has(key)) {
      delete parsed[key];
      modified = true;
    }
  }

  // Provider-specific field stripping
  const providerName = opts.provider || opts.family || "";
  const stripSet = PROVIDER_STRIP[providerName];
  if (stripSet) {
    for (const key of Object.keys(parsed)) {
      if (stripSet.has(key)) {
        delete parsed[key];
        modified = true;
      }
    }
  }

  // Normalize max_completion_tokens → max_tokens (OpenAI uses both, most providers want max_tokens)
  if (parsed.max_completion_tokens && !parsed.max_tokens) {
    parsed.max_tokens = parsed.max_completion_tokens;
    delete parsed.max_completion_tokens;
    modified = true;
  } else if (parsed.max_completion_tokens) {
    delete parsed.max_completion_tokens;
    modified = true;
  }

  // Cap max_tokens if configured
  if (maxOutputTokens > 0 && parsed.max_tokens) {
    if (parsed.max_tokens > maxOutputTokens) {
      parsed.max_tokens = maxOutputTokens;
      modified = true;
    }
  }

  // Ensure stream_options is only present when streaming
  if (parsed.stream_options && !parsed.stream) {
    delete parsed.stream_options;
    modified = true;
  }

  const body = modified ? JSON.stringify(parsed) : bodyStr;
  return { body, modified, parsed };
}

module.exports = { sanitize };
