import { GATEWAY_URL } from "./config";

async function handleJsonResponse(res: Response) {
  const json = await res.json();
  if (!res.ok) {
    const err: any = new Error(json?.error?.message || "Gateway error");
    err.payload = json;
    throw err;
  }
  return json;
}

function authHeaders(apiKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

export async function fetchModels(apiKey?: string) {
  const res = await fetch(`${GATEWAY_URL}/v1/models`, {
    headers: authHeaders(apiKey),
  });
  return handleJsonResponse(res);
}

export async function chatCompletion(params: {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  max_tokens?: number;
  apiKey?: string | null;
}) {
  if (!params.apiKey) {
    const err: any = new Error("Missing API key");
    err.payload = { error: { message: "Missing API key" } };
    throw err;
  }
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(params.apiKey || undefined),
    body: JSON.stringify({
      model: params.model ?? "gpt-5-nano",
      messages: params.messages,
      max_tokens: params.max_tokens ?? 200,
      stream: false,
    }),
  });
  const json = await handleJsonResponse(res);
  return json?.choices?.[0]?.message?.content ?? "";
}

export async function* chatCompletionStream(params: {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  max_tokens?: number;
  apiKey?: string | null;
  signal?: AbortSignal;
}) {
  if (!params.apiKey) {
    const err: any = new Error("Missing API key");
    err.payload = { error: { message: "Missing API key" } };
    throw err;
  }
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(params.apiKey || undefined),
    body: JSON.stringify({
      model: params.model ?? "gpt-5-nano",
      messages: params.messages,
      max_tokens: params.max_tokens ?? 200,
      stream: true,
    }),
    signal: params.signal,
  });

  if (!res.body) {
    throw new Error("No response body");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.replace(/^data:\s*/, "");
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload);
        if (json?.object === "error") {
          const err: any = new Error(json.message || "Gateway error");
          err.payload = json;
          throw err;
        }
        const content = json?.choices?.[0]?.delta?.content;
        if (typeof content === "string") {
          yield content;
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
}
