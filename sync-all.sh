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
  # Secure permissions check
  if [ "$(stat -c '%a' "$KEYMUX_DIR/.env" 2>/dev/null || stat -f '%Lp' "$KEYMUX_DIR/.env" 2>/dev/null)" != "600" ]; then
    echo "[sync-all] WARNING: .env should have mode 600 (got $(stat -c '%a' "$KEYMUX_DIR/.env" 2>/dev/null || stat -f '%Lp' "$KEYMUX_DIR/.env" 2>/dev/null))"
  fi

  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    case "$key" in \#*|"") continue;; esac
    # Strip surrounding quotes from value
    value="${value%\"}" ; value="${value#\"}"
    value="${value%\'}" ; value="${value#\'}"
    # Only export whitelisted keys
    case " $ALLOWED_KEYS " in
      *" $key "*) export "$key=$value" ;;
      *) ;; # silently skip non-whitelisted keys
    esac
  done < "$KEYMUX_DIR/.env"
fi

export KEYMUX_URL="http://127.0.0.1:8002"
export KEYMUX_PROXY_KEY="${PROXY_KEY:-}"

# Secure temp log file (avoid predictable /tmp paths)
SYNC_LOG="$(mktemp /tmp/keymux-sync.XXXXXXXX.log)"
trap 'rm -f "$SYNC_LOG"' EXIT

for f in ~/.openclaw/agents/*/agent/models.json; do
  "$NODE" "$KEYMUX_DIR/sync-models.js" "$f" >> "$SYNC_LOG" 2>&1
done

# Show output for systemd journal / manual runs
cat "$SYNC_LOG"
