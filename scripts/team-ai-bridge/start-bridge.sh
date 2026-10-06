#!/usr/bin/env bash
# Team AI bridge for macOS and Linux. Usage: scripts/team-ai-bridge/start-bridge.sh
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f bridge.config ]; then
  cp bridge.config.example bridge.config
  echo "Created scripts/team-ai-bridge/bridge.config. Fill in HPC_USERNAME, TEAM_AI_KEY and TUNNEL_TOKEN, then run this again."
  exit 1
fi
PYTHON=$(command -v python3 || command -v python || true)
if [ -z "$PYTHON" ]; then
  echo "Python 3 is required: https://www.python.org/downloads/ (or: brew install python)"
  exit 1
fi
exec "$PYTHON" bridge.py "$@"
