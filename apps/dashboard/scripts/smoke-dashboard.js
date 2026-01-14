#!/usr/bin/env node
const fetch = global.fetch || require('node-fetch');

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4001';
const API_KEY = process.env.GATEWAY_API_KEY;

async function main() {
  const headers = API_KEY
    ? { Authorization: `Bearer ${API_KEY}` }
    : {};
  const res = await fetch(`${GATEWAY_URL}/v1/models`, { headers });
  if (!res.ok) {
    console.error('FAIL: models request failed', res.status);
    process.exit(1);
  }
  const json = await res.json();
  if (!json?.data?.length) {
    console.error('FAIL: models data empty');
    process.exit(1);
  }
  console.log('OK: models reachable', json.data.length);

  if (API_KEY) {
    const chat = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5-nano',
        messages: [{ role: 'user', content: 'Output exactly:\nA\nB' }],
        max_tokens: 50,
        stream: false,
      }),
    });
    if (!chat.ok) {
      const errJson = await chat.json().catch(() => ({}));
      console.error('FAIL: chat request failed', chat.status, errJson);
      process.exit(1);
    }
    const chatJson = await chat.json();
    console.log('OK: chat completion content:', chatJson?.choices?.[0]?.message?.content);
  }
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
