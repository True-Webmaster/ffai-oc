#!/bin/bash
# Sync KeyMux models to all OpenClaw agents + openclaw.json
# Called by systemd ExecStartPre before gateway starts
# Sources .env for PROXY_KEY and provider API keys (needed for native model spec fetching)

set -euo pipefail

KEYMUX_DIR="$(cd "$(dirname "$0")" && pwd)"

# Exclusive lock — prevent concurrent instances from stomping each other
# Lock in KEYMUX_DIR (not /tmp) to avoid symlink-race on multi-user hosts
LOCKFILE="$KEYMUX_DIR/.sync.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
  echo "[sync-all] Another instance is running, exiting" >&2
  exit 0
fi

# Absolute path to node — avoid PATH hijacking
NODE="/usr/bin/node"
if [ ! -x "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
    echo "[sync-all] FATAL: node not found" >&2
    exit 1
  fi
fi

# Whitelist of env var keys allowed from .env (no blind export)
ALLOWED_KEYS="PROXY_KEY ADMIN_KEY PORT GEMINI_KEYS GROQ_KEYS XGROQ_KEYS OPENCLAW_JSON"

# Source env vars from .env — only whitelisted KEY=VALUE lines
if [ -f "$KEYMUX_DIR/.env" ]; then
  # Secure permissions check (capture once, default on failure to avoid set -e abort)
  envmode="$(stat -c '%a' "$KEYMUX_DIR/.env" 2>/dev/null || stat -f '%Lp' "$KEYMUX_DIR/.env" 2>/dev/null || echo "unknown")"
  if [ "$envmode" = "unknown" ]; then
    echo "[sync-all] FATAL: Could not determine .env permissions (file may have been removed)" >&2
    exit 1
  elif [ "$envmode" != "600" ]; then
    echo "[sync-all] FATAL: .env must have mode 600 (got $envmode) — run: chmod 600 .env" >&2
    exit 1
  fi

  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    case "$key" in \#*|"") continue;; esac
    # Trim whitespace from key
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # Trim leading/trailing whitespace from value first
    value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    # Single-pass quote stripping: detect opening quote character
    case "$value" in
      \"*) value="${value#\"}"; value="${value%\"}" ;;
      \'*) value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Only export whitelisted keys
    case " $ALLOWED_KEYS " in
      *" $key "*) export "$key=$value" ;;
      *) ;; # silently skip non-whitelisted keys
    esac
  done < "$KEYMUX_DIR/.env"
fi

export KEYMUX_URL="http://127.0.0.1:${PORT:-8002}"
export KEYMUX_PROXY_KEY="${PROXY_KEY:-}"

if [ -z "$KEYMUX_PROXY_KEY" ]; then
  echo "[sync-all] WARNING: PROXY_KEY is empty — sync requests will have no auth" >&2
fi

# Secure temp log file — restrictive umask, guard mktemp
umask 077
SYNC_LOG="$(mktemp /tmp/keymux-sync.XXXXXXXX.log)" || { echo "[sync-all] FATAL: mktemp failed" >&2; exit 1; }
# Cleanup temp file on exit (log display handled explicitly below)
trap 'rm -f "$SYNC_LOG"' EXIT INT TERM

# Guard HOME for tilde expansion
if [ -z "${HOME:-}" ]; then
  echo "[sync-all] FATAL: HOME is not set" >&2
  exit 1
fi

# Verify timeout command exists (may be absent in minimal Docker images)
TIMEOUT_CMD="$(command -v timeout 2>/dev/null || true)"
if [ -z "$TIMEOUT_CMD" ]; then
  echo "[sync-all] WARNING: timeout command not found, running without per-agent timeouts" >&2
fi

# Iterate agents — handle no matches gracefully
shopt -s nullglob
agent_files=("$HOME"/.openclaw/agents/*/agent/models.json)
shopt -u nullglob

if [ ${#agent_files[@]} -eq 0 ]; then
  echo "[sync-all] No agent models.json files found" >&2
  exit 0
fi

failures=0
for f in "${agent_files[@]}"; do
  # Extract agent name from path for log attribution
  agent_name="$(echo "$f" | sed 's|.*/agents/\([^/]*\)/.*|\1|')"
  echo "--- [sync-all] agent=$agent_name ---" >> "$SYNC_LOG"
  # 30s timeout per agent to prevent hung provider API from blocking startup
  exitcode=0
  if [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" 30 "$NODE" "$KEYMUX_DIR/sync-models.js" "$f" >> "$SYNC_LOG" 2>&1 || exitcode=$?
  else
    "$NODE" "$KEYMUX_DIR/sync-models.js" "$f" >> "$SYNC_LOG" 2>&1 || exitcode=$?
  fi
  if [ "$exitcode" -ne 0 ]; then
    if [ "$exitcode" -eq 124 ]; then
      echo "[sync-all] WARN: sync TIMED OUT for agent=$agent_name" >> "$SYNC_LOG"
    else
      echo "[sync-all] WARN: sync failed (exit $exitcode) for agent=$agent_name" >> "$SYNC_LOG"
    fi
    failures=$((failures + 1))
  fi
done

# Always show output for systemd journal / manual runs
cat "$SYNC_LOG"

if [ "$failures" -gt 0 ]; then
  echo "[sync-all] $failures/${#agent_files[@]} agent(s) failed to sync" >&2
  exit 1
fi
