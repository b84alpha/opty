#!/usr/bin/env bash
set +e

GATEWAY_URL="${GATEWAY_URL:-http://localhost:${PORT:-4000}}"
OPTYX_KEY="${OPTYX_KEY:-optyx_seed_demo_key_change_me}"

echo "Using GATEWAY_URL=$GATEWAY_URL"

curl --max-time 20 -sS -N "$GATEWAY_URL/v1/chat/completions" \
  -H "Authorization: Bearer $OPTYX_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-nano","messages":[{"role":"user","content":"Output exactly:\nA\nB"}],"max_tokens":200,"stream":true}' \
| tee /tmp/stream_ok.txt >/dev/null

echo
echo "DONE count:"; grep -c '\[DONE\]' /tmp/stream_ok.txt
echo "event leakage:"; grep -n "event: response" /tmp/stream_ok.txt || echo "OK (none)"

grep '^data: ' /tmp/stream_ok.txt \
  | sed 's/^data: //' \
  | grep -v '^\[DONE\]$' \
  | grep -E '^\{.*\}$' \
  > /tmp/stream_ok.jsonl

echo "joined content:"
jq -s '[ .[] | .choices[0].delta.content? // "" ] | join("")' /tmp/stream_ok.jsonl

echo "OK ✅"
