#!/usr/bin/env bash
# Recapper on your Mac (or Linux desktop), one command in Terminal:
#   curl -fsSL https://raw.githubusercontent.com/Saiberia/teste/claude/cloud-mode-claude-code-g6q3pn/deploy/run-mac.sh | bash
# Re-run it to start again / update.
set -euo pipefail
BRANCH="claude/cloud-mode-claude-code-g6q3pn"
ZIP="https://github.com/Saiberia/teste/archive/refs/heads/$BRANCH.zip"
APP_DIR="$HOME/Library/Application Support/Recapper"; [ "$(uname)" = Darwin ] || APP_DIR="$HOME/.local/share/recapper"
PORT="${RECAPPER_PORT:-8000}"
mkdir -p "$APP_DIR"
export PATH="$HOME/.local/bin:$PATH"

command -v uv >/dev/null || { echo "Installing uv..."; curl -LsSf https://astral.sh/uv/install.sh | sh; }
echo "Installing / updating Recapper..."
uv tool install --force --python 3.12 --reinstall-package recapper "recapper[asr] @ $ZIP"

[ -f "$APP_DIR/token.txt" ] || (LC_ALL=C tr -dc a-f0-9 </dev/urandom | head -c 32 > "$APP_DIR/token.txt")
TOKEN="$(cat "$APP_DIR/token.txt")"

export RECAPPER_LLM="${RECAPPER_LLM:-openai}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://127.0.0.1:8045/v1}"
export RECAPPER_OPENAI_MODEL="${RECAPPER_OPENAI_MODEL:-gemini-2.5-flash}"

URL="http://127.0.0.1:$PORT"
recapper serve --port "$PORT" --token "$TOKEN" --data-dir "$APP_DIR/data" &
PID=$!
trap 'kill $PID 2>/dev/null' INT TERM EXIT
for _ in $(seq 1 120); do curl -fs "$URL/api/health" >/dev/null 2>&1 && break; sleep 0.5; kill -0 $PID || exit 1; done
(command -v open >/dev/null && open "$URL/?token=$TOKEN") || (command -v xdg-open >/dev/null && xdg-open "$URL/?token=$TOKEN") || true
echo
echo "Recapper is running:  $URL/?token=$TOKEN"
echo "Extension settings:   server $URL   token $TOKEN"
echo "Keep this window open. Ctrl+C stops Recapper."
wait $PID
