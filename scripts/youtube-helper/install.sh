#!/usr/bin/env bash
# Sets up the YouTube helper on this machine as a systemd user service on 127.0.0.1:8096.
# Safe to run again: it keeps an existing key and only rewrites its own unit.
set -euo pipefail
HELPER_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="${YT_HELPER_STATE:-$HOME/.local/share/youtube-helper}"
VENV="$STATE/venv"
KEY_FILE="$HOME/.secrets/youtube-helper-key.txt"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node is needed for YouTube's JavaScript challenges" >&2; exit 1; fi

mkdir -p "$STATE"
# The service runs its own copy, so switching branches in this checkout cannot break it.
install -m 644 "$HELPER_DIR/helper.py" "$STATE/helper.py"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade --disable-pip-version-check pip 'yt-dlp[default]'

if [ ! -s "$KEY_FILE" ]; then
  mkdir -p "$(dirname "$KEY_FILE")"
  chmod 700 "$(dirname "$KEY_FILE")"
  (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(48), end="")' > "$KEY_FILE")
  echo "Wrote a new key to $KEY_FILE"
fi
chmod 600 "$KEY_FILE"

mkdir -p "$HOME/.config/systemd/user"
sed -e "s#@STATE@#$STATE#g" -e "s#@VENV@#$VENV#g" -e "s#@NODE@#$NODE#g" \
  "$HELPER_DIR/youtube-helper.service" > "$HOME/.config/systemd/user/youtube-helper.service"
systemctl --user daemon-reload
systemctl --user enable youtube-helper.service
systemctl --user restart youtube-helper.service
sleep 2
curl -fsS http://127.0.0.1:8096/health
echo
echo "Running. Logs: journalctl --user -u youtube-helper -f"
