#!/bin/bash
# Sync KeyMux models to all OpenClaw agents + openclaw.json
# Called by systemd ExecStartPre before gateway starts
# Sources .env for PROXY_KEY and provider API keys (needed for native model spec fetching)

set -euo pipefail

KEYMUX_DIR="$(cd "$(dirname "$0")" && pwd)"

# Exclusive lock — prevent concurrent instances from stomping each other
LOCKFILE="/tmp/keymux-sync.lock"
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
  if [ "$envmode" != "600" ]; then
    echo "[sync-all] WARNING: .env should have mode 600 (got $envmode)"
  fi

  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    case "$key" in \#*|"") continue;; esac
    # Trim whitespace from key
    key="$(echo "$key" | tr -d '[:space:]')"
    # Single-pass quote stripping: detect opening quote character
    case "$value" in
      \"*) value="${value#\"}"; value="${value%\"}" ;;
      \'*) value="${value#\'}"; value="${value%\'}" ;;
    esac
    # Trim leading/trailing whitespace from value
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    # Only export whitelisted keys
    case " $ALLOWED_KEYS " in
      *" $key "*) export "$key=$value" ;;
      *) ;; # silently skip non-whitelisted keys
    esac
  done < "$KEYMUX_DIR/.env"
fi

export KEYMUX_URL="http://127.0.0.1:${PORT:-8002}"
export KEYMUX_PROXY_KEY="${PROXY_KEY:-}"

# Clean stale temp files from prior crash-restart loops
rm -f /tmp/keymux-sync.*.log 2>/dev/null || true

# Secure temp log file — restrictive umask, guard mktemp
umask 077
SYNC_LOG="$(mktemp /tmp/keymux-sync.XXXXXXXX.log)" || { echo "[sync-all] FATAL: mktemp failed" >&2; exit 1; }
# Only cat log on failure; always clean up
trap 'exitcode=$?; if [ "$exitcode" -ne 0 ]; then cat "$SYNC_LOG" 2>/dev/null; fi; rm -f "$SYNC_LOG"' EXIT INT TERM

# Guard HOME for tilde expansion
if [ -z "${HOME:-}" ]; then
  echo "[sync-all] FATAL: HOME is not set" >&2
  exit 1
fi

# Iterate agents — handle no matches gracefully
shopt -s nullglob
agent_files=("$HOME"/.openclaw/agents/*/agent/models.json)
shopt -u nullglob

if [ ${#agent_files[@]} -eq 0 ]; then
  echo "[sync-all] No agent models.json files found"
  exit 0
fi

failures=0
for f in "${agent_files[@]}"; do
  # 30s timeout per agent to prevent hung provider API from blocking startup
  exitcode=0
  timeout 30 "$NODE" "$KEYMUX_DIR/sync-models.js" "$f" >> "$SYNC_LOG" 2>&1 || exitcode=$?
  if [ "$exitcode" -ne 0 ]; then
    if [ "$exitcode" -eq 124 ]; then
      echo "[sync-all] WARN: sync TIMED OUT for $f" >> "$SYNC_LOG"
    else
      echo "[sync-all] WARN: sync failed (exit $exitcode) for $f" >> "$SYNC_LOG"
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
