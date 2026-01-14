#!/usr/bin/env bash
set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://localhost:${PORT:-4000}}"
OPTYX_KEY="${OPTYX_KEY:-optyx_seed_demo_key_change_me}"
OUT="/tmp/stream_ok.txt"
JSONL="/tmp/stream_ok.jsonl"

echo "Using GATEWAY_URL=$GATEWAY_URL"

if ! curl --max-time 20 -sS -N "$GATEWAY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OPTYX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-nano","messages":[{"role":"user","content":"Output exactly:\nA\nB"}],"max_tokens":200,"stream":true}' \
  > "$OUT"; then
  echo "FAIL: curl request failed" >&2
  exit 1
fi

data_lines=$(grep '^data: ' "$OUT" || true)
if [[ -z "$data_lines" ]]; then
  echo "FAIL: no data lines found" >&2
  exit 1
fi

done_count=$(grep -c '\[DONE\]' "$OUT" || true)
if [[ "$done_count" != "1" ]]; then
  echo "FAIL: expected exactly one [DONE], got $done_count" >&2
  exit 1
fi

if printf "%s\n" "$data_lines" | grep -q 'event: response'; then
  echo "FAIL: found response event leakage" >&2
  exit 1
fi

printf "%s\n" "$data_lines" \
  | sed 's/^data: //' \
  | grep -v '^\[DONE\]$' \
  | grep -E '^\{.*\}$' \
  > "$JSONL" || true

if [[ ! -s "$JSONL" ]]; then
  echo "FAIL: no JSON data chunks" >&2
  exit 1
fi

joined=$(jq -s '[ .[] | .choices[0].delta.content? // "" ] | join("")' "$JSONL")
if [[ "$joined" != "\"A\nB\"" ]]; then
  echo "FAIL: content mismatch. Got: $joined" >&2
  exit 1
fi

echo "PASS: stream invariants OK (output in $OUT)" >&2
