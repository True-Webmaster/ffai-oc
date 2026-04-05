#!/bin/bash
# Sync KeyMux models to all OpenClaw agents + openclaw.json
# Called by systemd ExecStartPre before gateway starts
# Sources .env for PROXY_KEY and provider API keys (needed for native model spec fetching)

KEYMUX_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source env vars from .env (PROXY_KEY, GEMINI_KEYS, GROQ_KEYS, etc.)
# Only sources KEY=VALUE lines, skipping comments and empty lines
if [ -f "$KEYMUX_DIR/.env" ]; then
  set -a
  while IFS='=' read -r key value; do
    # Skip comments and empty lines
    case "$key" in \#*|"") continue;; esac
    # Strip surrounding quotes from value
    value="${value%\"}" ; value="${value#\"}"
    value="${value%\'}" ; value="${value#\'}"
    export "$key=$value"
  done < "$KEYMUX_DIR/.env"
  set +a
fi

export KEYMUX_URL="http://127.0.0.1:8002"
export KEYMUX_PROXY_KEY="${PROXY_KEY:-}"

for f in ~/.openclaw/agents/*/agent/models.json; do
  node "$KEYMUX_DIR/sync-models.js" "$f" >> /tmp/keymux-sync.log 2>&1
done
