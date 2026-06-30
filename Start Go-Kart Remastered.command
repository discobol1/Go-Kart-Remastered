#!/bin/bash
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
URL="http://localhost:${PORT}/"

if [ -x ./go-kart-remastered ]; then
  echo ""
  echo "  Go-Kart Remastered — race server"
  echo ""
  ./go-kart-remastered &
  PID=$!
  trap 'kill "$PID" 2>/dev/null; exit' INT TERM
  sleep 2
  open "$URL" 2>/dev/null || true
  echo "  Setup page: $URL"
  echo "  Keep this window open. Press Ctrl+C to stop."
  echo ""
  wait "$PID"
  exit $?
fi

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install from https://nodejs.org/ or use the standalone release build."
  echo ""
  read -r -p "Press Enter to close…"
  exit 1
fi

exec node scripts/launch.js
