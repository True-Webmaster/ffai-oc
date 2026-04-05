#!/bin/bash
# Sync KeyMux models to all OpenClaw agents + openclaw.json
# Called by systemd ExecStartPre before gateway starts
# Reads PROXY_KEY from KeyMux .env file

KEYMUX_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source PROXY_KEY from .env (avoid exporting all vars)
if [ -f "$KEYMUX_DIR/.env" ]; then
  PROXY_KEY=$(grep "^PROXY_KEY=" "$KEYMUX_DIR/.env" | cut -d= -f2-)
fi

export KEYMUX_URL="http://127.0.0.1:8002"
export KEYMUX_PROXY_KEY="${PROXY_KEY:-}"

for f in ~/.openclaw/agents/*/agent/models.json; do
  node "$KEYMUX_DIR/sync-models.js" "$f" >> /tmp/keymux-sync.log 2>&1
done
