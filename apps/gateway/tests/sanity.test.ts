import assert from "assert";
import { AddressInfo } from "net";
import { defaultFastModelId } from "@optyx/shared";
import { buildApp } from "../src/index";

const API_KEY = "optyx_seed_demo_key_change_me";

async function readStream(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const res = await fetch(url, { ...init, signal: controller.signal });
  assert.strictEqual(res.status, 200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let gotChunk = false;
  let gotDone = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const text = decoder.decode(value);
        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          if (line === "data: [DONE]") gotDone = true;
          if (line.startsWith("data: {") && !line.includes("[DONE]")) gotChunk = true;
        }
      }
      if (gotChunk && gotDone) break;
    }
  } finally {
    clearTimeout(timeout);
  }
  assert.ok(gotChunk, "stream should emit data chunk");
  assert.ok(gotDone, "stream should emit [DONE]");
}

async function main() {
  process.env.GATEWAY_MOCK = "1";
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";
  process.env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "test";

  const app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as AddressInfo | string | null;
  const port =
    addr && typeof addr === "object"
      ? addr.port
      : Number(String(addr ?? "").split(":").pop());
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  const health = await fetch(`${base}/health`);
  assert.strictEqual(health.status, 200);
  const healthJson = await health.json();
  assert.strictEqual(healthJson.ok, true);

  const modelsRes = await fetch(`${base}/v1/models`);
  assert.strictEqual(modelsRes.status, 200);
  const models = await modelsRes.json();
  assert.ok(models.data.length >= 3);

  const aliasRes = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.strictEqual(aliasRes.status, 200);
  assert.strictEqual(aliasRes.headers.get("x-optyx-resolved-model"), defaultFastModelId);
  const aliasJson = await aliasRes.json();
  assert.strictEqual(aliasJson.model, defaultFastModelId);

  const bad = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "not-a-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.strictEqual(bad.status, 400);

  await readStream(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: [{ role: "user", content: "stream" }], stream: true }),
  });

  await app.close();
  console.log("gateway sanity tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
