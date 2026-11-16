#!/usr/bin/env bash
# Keeps the marketplace up for the demo: restarts it a few seconds after any exit.
# Stop with Ctrl-C (twice if it is mid-restart).
cd "$(dirname "$0")/.."
while true; do
  npm run marketplace
  echo "[serve] marketplace exited with $?; restarting in 3 s" >&2
  sleep 3
done
