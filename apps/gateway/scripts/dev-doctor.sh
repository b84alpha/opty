#!/usr/bin/env bash
set -euo pipefail

echo "Checking listeners on 4000/4001..." >&2
lsof -nP -i :4000 -sTCP:LISTEN || true
lsof -nP -i :4001 -sTCP:LISTEN || true

if [[ $# -ge 1 ]]; then
  pid="$1"
  if [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "Killing PID $pid" >&2
    kill "$pid"
  else
    echo "Argument is not a PID; skipping kill" >&2
  fi
fi

echo "Starting gateway on PORT=4001 (GATEWAY_MOCK=0)" >&2
PORT=4001 GATEWAY_MOCK=0 pnpm dev >/tmp/gateway-dev-doctor.log 2>&1 &
gw_pid=$!
sleep 2

echo "Curling /health..." >&2
if curl -sf http://localhost:4001/health >/tmp/gateway-dev-doctor-health.json; then
  echo "Gateway healthy on 4001" >&2
  cat /tmp/gateway-dev-doctor-health.json
else
  echo "Gateway health check failed" >&2
  cat /tmp/gateway-dev-doctor.log >&2 || true
fi

echo "Stopping gateway PID $gw_pid" >&2
kill "$gw_pid" >/dev/null 2>&1 || true
wait "$gw_pid" 2>/dev/null || true
echo "Done." >&2
