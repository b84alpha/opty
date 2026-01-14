import assert from "assert";
import { AddressInfo } from "net";
import { request } from "http";
import { defaultFastModelId } from "@optyx/shared";
import { buildApp } from "../src/index";

const API_KEY = "optyx_seed_demo_key_change_me";

async function readStream(url: string, init?: RequestInit) {
  const timeout = setTimeout(() => {
    throw new Error("stream timeout");
  }, 4000);

  const headers = {
    ...(init?.headers as Record<string, string> | undefined),
    Origin: "http://localhost:3000",
  };

  const { hostname, port, pathname } = new URL(url);

  const chunks: Buffer[] = [];
  let statusCode = 0;
  const resHeaders: Record<string, string | string[]> = await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        path: pathname,
        method: init?.method || "POST",
        headers,
      },
      (res) => {
        statusCode = res.statusCode || 0;
        res.on("data", (d) => chunks.push(Buffer.from(d)));
        res.on("end", () => resolve(res.headers as any));
      }
    );
    req.on("error", reject);
    req.end(init?.body as any);
  });

  clearTimeout(timeout);

  const rawText = Buffer.concat(chunks).toString("utf8");
  assert.strictEqual(statusCode, 200);
  const getHeader = (key: string) => {
    const val = resHeaders[key.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val || null;
  };
  assert.strictEqual(getHeader("content-type"), "text/event-stream; charset=utf-8");
  assert.ok((getHeader("cache-control") || "").includes("no-cache"));
  assert.ok((getHeader("connection") || "").includes("keep-alive"));
  assert.strictEqual(
    getHeader("access-control-allow-origin"),
    "http://localhost:3000",
    "missing ACAO header"
  );

  const text = rawText;
  // ensure framing is double-newline separated
  assert.ok(text.includes("\n\n"), "SSE framing must include blank lines");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let gotChunk = false;
  let gotDone = false;
  let gotError = false;
  let sawNewline = false;

  for (const line of lines) {
    if (line === "data: [DONE]") gotDone = true;
    if (
      line.startsWith("data: {") &&
      !line.includes("[DONE]") &&
      line.includes("\"content\"") &&
      line.includes("\"chat.completion.chunk\"")
    ) {
      gotChunk = true;
      if (line.includes("\\n")) sawNewline = true;
    }
    if (line.startsWith("data: {") && line.includes("OUTPUT_TRUNCATED")) {
      gotError = true;
    }
  }

  assert.ok(!text.includes("event: response."), "should not leak response.* events");
  const doneCount = (text.match(/\[DONE\]/g) || []).length;
  assert.strictEqual(doneCount, 1, "should emit exactly one [DONE]");
  assert.ok(gotChunk || gotError, "stream should emit data chunk or error");
  assert.ok(gotDone, "stream should emit [DONE]");
  if (gotChunk) {
    assert.ok(sawNewline, "stream should preserve newline content");
  }
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

  const projectRes = await fetch(`${base}/admin/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Test Admin Project" }),
  });
  assert.strictEqual(projectRes.status, 200);
  const projectJson = await projectRes.json();
  const projectId = projectJson?.project?.id;
  assert.ok(projectId);

  const keyRes = await fetch(`${base}/admin/projects/${projectId}/keys`, { method: "POST" });
  assert.strictEqual(keyRes.status, 200);
  const keyJson = await keyRes.json();
  const newKey = keyJson?.key;
  assert.ok(newKey, "key should be returned");

  const aliasRes = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${newKey}` },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "Output exactly:\nA\nB" }],
      max_tokens: 50,
    }),
  });
  assert.ok([200, 400, 422].includes(aliasRes.status));
  assert.strictEqual(aliasRes.headers.get("x-optyx-resolved-model"), defaultFastModelId);
  const aliasJson = await aliasRes.json();
  if (aliasRes.status === 200) {
    assert.strictEqual(aliasJson.model, defaultFastModelId);
    assert.ok(
      aliasJson?.choices?.[0]?.message?.content,
      "non-stream response should include assistant content"
    );
    assert.ok(
      String(aliasJson.choices[0].message.content).length > 0,
      "assistant content should not be empty"
    );
  } else {
    assert.ok(
      aliasJson?.error?.code === "OUTPUT_TRUNCATED",
      "error code should be OUTPUT_TRUNCATED when text missing"
    );
  }

  const bad = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${newKey}` },
    body: JSON.stringify({ model: "not-a-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.strictEqual(bad.status, 400);

  await readStream(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${newKey}` },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "Output exactly:\nA\nB" }],
      max_tokens: 50,
      stream: true,
    }),
  });

  await fetch(`${base}/admin/keys/${keyJson?.id ?? ""}/revoke`, { method: "POST" });
  const revokedCall = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${newKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "still there?" }],
    }),
  });
  assert.strictEqual(revokedCall.status, 401);

  await app.close();
  console.log("gateway sanity tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
