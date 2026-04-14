/**
 * Smush command output compressor — detects CLI output types and strips noise.
 *
 * Supported: test runners, build output, git status/diff/log, npm/yarn, docker.
 * Fallback: generic dedup + whitespace normalization.
 */
"use strict";

const { stripAnsi, stripProgressLines } = require("./util.js");

// ── Output type detection ──────────────────────────────────────────────────

function detectOutputType(lines) {
  const sample = lines.slice(0, 20).join("\n").toLowerCase();
  const first = (lines[0] || "").toLowerCase();

  if (sample.includes("test result:") || (sample.includes("running") && sample.includes("test")))
    return "cargo-test";
  if (sample.includes("compiling") && (sample.includes("finished") || sample.includes("error[e")))
    return "cargo-build";
  if (sample.includes("error[e"))
    return "cargo-build";
  if (first.startsWith("diff --git"))
    return "git-diff";
  if (/^commit [0-9a-f]{7,}/.test(first))
    return "git-log";
  if (first.startsWith("on branch") || sample.includes("changes not staged") || sample.includes("changes to be committed"))
    return "git-status";
  if (sample.includes("test suites:") || sample.includes("tests passed") ||
      (sample.includes("passed") && sample.includes("failed")) ||
      /\bPASS\b/.test(sample) || /\bFAIL\b/.test(sample) || sample.includes("✓") || sample.includes("✗"))
    return "test-runner";
  if ((sample.includes("npm") || sample.includes("yarn") || sample.includes("pnpm")) &&
      (sample.includes("added") || sample.includes("npm err") || sample.includes("npm warn")))
    return "npm";
  if (sample.includes("container id") || sample.includes("repository") || first.startsWith("docker"))
    return "docker";

  return null;
}

// ── Cargo test ─────────────────────────────────────────────────────────────

function compressCargoTest(lines) {
  let totalTests = 0;
  const failures = [];
  let inFailureBlock = false;
  let failureDetail = [];
  let resultLine = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const runMatch = trimmed.match(/running (\d+) tests?/);
    if (runMatch) { totalTests += parseInt(runMatch[1], 10); continue; }

    if (trimmed.startsWith("test result:")) { resultLine = trimmed; continue; }

    if (trimmed.startsWith("---- ") && trimmed.endsWith(" ----")) {
      if (failureDetail.length > 0) failures.push(failureDetail.join("\n"));
      failureDetail = [];
      inFailureBlock = true;
      continue;
    }

    if (inFailureBlock) {
      if (trimmed === "failures:" || trimmed.startsWith("test result:")) {
        if (failureDetail.length > 0) failures.push(failureDetail.join("\n"));
        failureDetail = [];
        inFailureBlock = false;
        if (trimmed.startsWith("test result:")) resultLine = trimmed;
      } else {
        failureDetail.push(trimmed);
      }
      continue;
    }

    if (/test .+ \.\.\. FAILED/.test(trimmed)) {
      const name = trimmed.replace(/^test\s+/, "").replace(/\s+\.\.\.\s+FAILED$/, "");
      failures.push(`FAIL: ${name}`);
    }
  }
  if (failureDetail.length > 0) failures.push(failureDetail.join("\n"));

  // Fallback: count passed tests from result line if "running N tests" wasn't found
  if (totalTests === 0 && resultLine) {
    const passMatch = resultLine.match(/(\d+)\s+passed/);
    const failMatch = resultLine.match(/(\d+)\s+failed/);
    totalTests = (passMatch ? parseInt(passMatch[1], 10) : 0) + (failMatch ? parseInt(failMatch[1], 10) : 0);
  }

  const out = [];
  if (failures.length === 0) {
    out.push(`running ${totalTests} tests — all passed`);
  } else {
    out.push(`running ${totalTests} tests — ${failures.length} FAILED`);
    out.push(...failures);
  }
  if (resultLine) out.push(resultLine);
  return out.join("\n");
}

// ── Cargo build ────────────────────────────────────────────────────────────

function compressCargoBuild(lines) {
  const out = [];
  const seenWarnings = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(Compiling|Downloading|Blocking|Updating)\s/.test(trimmed)) continue;

    if (trimmed.includes("error[E") || trimmed.startsWith("error") || /\berror:/.test(trimmed)) {
      out.push(trimmed);
      continue;
    }
    if (trimmed.startsWith("warning") && !seenWarnings.has(trimmed)) {
      seenWarnings.add(trimmed);
      out.push(trimmed);
      continue;
    }
    if (/^\s*(-->|[|]|\s*=\s*(help|note):)/.test(line)) {
      out.push(trimmed);
      continue;
    }
    if (trimmed.startsWith("Finished") || trimmed.includes("generated") && trimmed.includes("warning")) {
      out.push(trimmed);
    }
  }
  return out.join("\n") || "Build completed (no errors or warnings)";
}

// ── Git status ─────────────────────────────────────────────────────────────

function compressGitStatus(lines) {
  let branch = "";
  const staged = [], modified = [], deleted = [], untracked = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("(use")) continue;
    if (trimmed.startsWith("Your branch")) continue;

    if (trimmed.startsWith("On branch")) {
      branch = trimmed.replace("On branch ", "");
      continue;
    }

    const fileMatch = trimmed.match(/^(modified|new file|deleted|renamed):\s+(.+)/);
    if (fileMatch) {
      const [, type, file] = fileMatch;
      if (type === "new file") staged.push(file);
      else if (type === "modified") modified.push(file);
      else if (type === "deleted") deleted.push(file);
      else if (type === "renamed") modified.push(file);
      continue;
    }

    // Short-format status lines: "?? file", "M  file", " M file", "A  file", etc.
    const shortMatch = trimmed.match(/^([MADRCU?! ]{2})\s+(.+)/);
    if (shortMatch) {
      const [, status, file] = shortMatch;
      if (status === "??") untracked.push(file);
      else if (status.trim().startsWith("D")) deleted.push(file);
      else if (status.trim().startsWith("A")) staged.push(file);
      else if (status.trim().startsWith("R")) modified.push(file);
      else modified.push(file);
      continue;
    }

    // Long-format: lines under "Untracked files:" are just filenames (tab-indented)
    if (/^\t/.test(line) && !line.includes(":")) {
      untracked.push(trimmed);
    }
  }

  const out = [];
  if (branch) out.push(`branch: ${branch}`);
  if (staged.length) out.push(`staged: ${staged.join(", ")}`);
  if (modified.length) out.push(`modified: ${modified.join(", ")}`);
  if (deleted.length) out.push(`deleted: ${deleted.join(", ")}`);
  if (untracked.length) out.push(`untracked: ${untracked.join(", ")}`);
  if (out.length <= 1) out.push("clean working tree");
  return out.join("\n");
}

// ── Git diff ───────────────────────────────────────────────────────────────

function compressGitDiff(lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/b\/(.+)$/);
      out.push(`--- ${match ? match[1] : line} ---`);
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("old mode") || line.startsWith("new mode")) continue;
    if (line.startsWith("--- a/") || line.startsWith("+++ b/")) continue;
    if (line.startsWith("@@") || line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      out.push(line);
      continue;
    }
    if (line.includes("Binary file")) out.push(line);
  }
  return out.join("\n");
}

// ── Git log ────────────────────────────────────────────────────────────────

function compressGitLog(lines) {
  const commits = [];
  let hash = "", date = "", msg = "";

  for (const line of lines) {
    const trimmed = line.trim();
    const commitMatch = trimmed.match(/^commit ([0-9a-f]+)/);
    if (commitMatch) {
      if (hash && msg) commits.push(`${hash.slice(0, 7)} ${msg}${date ? ` (${date})` : ""}`);
      hash = commitMatch[1];
      date = "";
      msg = "";
      continue;
    }
    if (trimmed.startsWith("Author:") || trimmed.startsWith("Merge:")) continue;
    if (trimmed.startsWith("Date:")) {
      date = trimmed.replace("Date:", "").trim().slice(0, 16);
      continue;
    }
    if (!msg && trimmed) msg = trimmed;
  }
  if (hash && msg) commits.push(`${hash.slice(0, 7)} ${msg}${date ? ` (${date})` : ""}`);
  return commits.join("\n");
}

// ── Test runner (jest/vitest/mocha/pytest) ──────────────────────────────────

function compressTestRunner(lines) {
  const out = [];
  let inFailure = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Summary lines — always keep
    if (/test suites?:/i.test(trimmed) || /tests?:/i.test(trimmed) && /passed|failed/i.test(trimmed) ||
        trimmed.startsWith("Tests:") || trimmed.startsWith("Test Suites:")) {
      out.push(trimmed);
      continue;
    }

    // Failure details — keep
    if (/\bFAIL\b/.test(trimmed) || trimmed.includes("✗") || trimmed.includes("✘") ||
        /\berror\b/i.test(trimmed) || trimmed.includes("expected") || trimmed.includes("received") ||
        trimmed.includes("AssertionError") || trimmed.includes("assert")) {
      out.push(trimmed);
      inFailure = true;
      continue;
    }

    // After a failure, keep context lines (indented)
    if (inFailure && line.startsWith("  ")) {
      out.push(trimmed);
      continue;
    }

    inFailure = false;
    // Skip individual PASS lines
  }
  return out.join("\n") || "All tests passed";
}

// ── npm/yarn ───────────────────────────────────────────────────────────────

function compressNpm(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/npm ERR!/i.test(trimmed) || /npm WARN/i.test(trimmed)) { out.push(trimmed); continue; }
    if (/added \d+ packages/.test(trimmed) || trimmed.includes("up to date")) { out.push(trimmed); continue; }
    if (/vulnerabilit/i.test(trimmed) || /audit/i.test(trimmed)) { out.push(trimmed); continue; }
  }
  return out.join("\n") || lines.slice(0, 3).join("\n");
}

// ── Docker ─────────────────────────────────────────────────────────────────

const SHA_RE = /[0-9a-f]{64}/g;

function compressDocker(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^Step \d+\/\d+/.test(trimmed) && !/error/i.test(trimmed)) continue;
    if (/^(Pulling|Waiting|Downloading|Extracting)\s/.test(trimmed)) continue;
    out.push(trimmed.replace(SHA_RE, (m) => m.slice(0, 12)));
  }
  return out.join("\n") || "Docker operation completed";
}

// ── Generic fallback ───────────────────────────────────────────────────────

function genericCompress(lines) {
  const out = [];
  let blankCount = 0;
  let lastNormalized = "";
  let dupCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Max 1 consecutive blank line
    if (!trimmed) {
      if (blankCount < 1) out.push("");
      blankCount++;
      continue;
    }
    blankCount = 0;

    // Dedup consecutive identical lines (normalized)
    const normalized = trimmed.toLowerCase();
    if (normalized === lastNormalized && trimmed.length >= 15) {
      dupCount++;
      continue;
    }
    if (dupCount > 0) {
      out.push(`[... repeated ${dupCount + 1} times]`);
      dupCount = 0;
    }
    lastNormalized = normalized;
    out.push(trimmed);
  }
  if (dupCount > 0) out.push(`[... repeated ${dupCount + 1} times]`);

  return out.join("\n");
}

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Compress CLI/tool output text.
 * @param {string} text - Raw output text
 * @returns {{ text: string, compressed: boolean }}
 */
function compressCmdOutput(text) {
  if (!text || text.length < 200) return { text, compressed: false };

  // Pre-process: strip ANSI and progress lines
  let cleaned = stripAnsi(text);
  cleaned = stripProgressLines(cleaned);
  const lines = cleaned.split("\n");

  // Detect and compress
  const type = detectOutputType(lines);
  let result;

  switch (type) {
    case "cargo-test": result = compressCargoTest(lines); break;
    case "cargo-build": result = compressCargoBuild(lines); break;
    case "git-status": result = compressGitStatus(lines); break;
    case "git-diff": result = compressGitDiff(lines); break;
    case "git-log": result = compressGitLog(lines); break;
    case "test-runner": result = compressTestRunner(lines); break;
    case "npm": result = compressNpm(lines); break;
    case "docker": result = compressDocker(lines); break;
    default: result = genericCompress(lines); break;
  }

  // Safety: only use compressed if < 80% of original
  if (result.length >= cleaned.length * 0.8) {
    return { text, compressed: false };
  }

  return { text: result, compressed: true };
}

module.exports = { compressCmdOutput };
