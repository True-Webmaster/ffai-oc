#!/bin/bash
# Sync KeyMux models to all OpenClaw agents + openclaw.json
# Called by systemd ExecStartPre before gateway starts
# Sources .env for PROXY_KEY and provider API keys (needed for native model spec fetching)

set -euo pipefail

KEYMUX_DIR="$(cd "$(dirname "$0")" && pwd)"

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
  # Secure permissions check (capture once to avoid TOCTOU)
  envmode="$(stat -c '%a' "$KEYMUX_DIR/.env" 2>/dev/null || stat -f '%Lp' "$KEYMUX_DIR/.env" 2>/dev/null)"
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
trap 'cat "$SYNC_LOG" 2>/dev/null; rm -f "$SYNC_LOG"' EXIT INT TERM

# Iterate agents — handle no matches gracefully
shopt -s nullglob
agent_files=(~/.openclaw/agents/*/agent/models.json)
shopt -u nullglob

if [ ${#agent_files[@]} -eq 0 ]; then
  echo "[sync-all] No agent models.json files found"
  exit 0
fi

failures=0
for f in "${agent_files[@]}"; do
  # 30s timeout per agent to prevent hung provider API from blocking startup
  if ! timeout 30 "$NODE" "$KEYMUX_DIR/sync-models.js" "$f" >> "$SYNC_LOG" 2>&1; then
    echo "[sync-all] WARN: sync failed for $f" >> "$SYNC_LOG"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "[sync-all] $failures/${#agent_files[@]} agent(s) failed to sync" >> "$SYNC_LOG"
  exit 1
fi
