#!/usr/bin/env node
const fetch = global.fetch || require('node-fetch');

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:4001';

async function main() {
  const res = await fetch(`${GATEWAY_URL}/v1/models`);
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
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
