import { ProviderAdapter, ChatResult, UsageTotals, EmbeddingsResult } from "./types";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const RESPONSES_URL = "https://api.openai.com/v1/responses";

function openAiHeaders() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}

export function parseOpenAIUsageFromChunk(
  chunk: string
): UsageTotals | null {
  const lines = chunk.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.replace(/^data:\s*/, "");
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.usage) {
        return {
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
        };
      }
    } catch {
      // ignore malformed SSE chunks
    }
  }
  return null;
}

function extractResponseText(json: any): string {
  if (!json) return "";
  if (typeof json.output_text === "string" && json.output_text.trim()) return json.output_text;

  const outputItems = json.output ?? json.outputs ?? [];
  for (const item of outputItems) {
    if (item?.type === "message") {
      const parts = item?.content ?? item?.contents ?? [];
      const texts = parts
        .map((p: any) => {
          if (p?.type === "output_text" && typeof p.text === "string") return p.text;
          if (typeof p.text === "string") return p.text;
          return "";
        })
        .filter((t: string) => t.trim().length > 0);
      if (texts.length) return texts.join("");
    }
    const parts = item?.content ?? item?.contents ?? [];
    for (const p of parts) {
      if (p?.type === "output_text" && typeof p.text === "string" && p.text.trim()) return p.text;
      if (typeof p.text === "string" && p.text.trim()) return p.text;
    }
  }

  const messages = json.messages ?? [];
  for (const msg of messages) {
    const parts = msg?.content ?? msg?.contents ?? [];
    for (const p of parts) {
      if (p?.type === "output_text" && typeof p.text === "string" && p.text.trim()) return p.text;
      if (typeof p.text === "string" && p.text.trim()) return p.text;
    }
  }

  if (typeof json.text === "string" && json.text.trim()) return json.text;
  return "";
}

function parseResponsesUsage(obj: any): UsageTotals | null {
  const u = obj?.usage ?? obj?.output?.[0]?.usage ?? obj?.outputs?.[0]?.usage;
  if (!u) return null;
  const prompt = u.input_tokens ?? u.prompt_tokens ?? u.total_tokens ?? null;
  const completion = u.output_tokens ?? u.completion_tokens ?? null;
  return {
    prompt_tokens: prompt ?? null,
    completion_tokens: completion ?? null,
  };
}

function makeChatLikeResponse(params: { json: any; model: string }): any {
  const text = extractResponseText(params.json);
  return {
    id: params.json?.id ?? `resp-${Date.now()}`,
    object: "chat.completion",
    created: params.json?.created ?? Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: params.json?.output?.[0]?.finish_reason ?? params.json?.finish_reason ?? "stop",
      },
    ],
    usage: params.json?.usage ?? params.json?.output?.[0]?.usage ?? null,
  };
}

function normalizeReasoning(reasoning: any): any {
  if (!reasoning) return { effort: "low" };
  if (typeof reasoning === "string") return { effort: reasoning };
  if (typeof reasoning === "object" && reasoning.effort) return { effort: reasoning.effort };
  return { effort: "low" };
}

function toResponsesInput(messages: any[]) {
  return messages.map((m) => {
    const role = (m?.role as string) || "user";
    const contentVal = m?.content;
    let text: string;
    if (typeof contentVal === "string") text = contentVal;
    else if (Array.isArray(contentVal)) {
      text = contentVal
        .map((c: any) => {
          if (typeof c === "string") return c;
          if (c?.type === "text" && typeof c.text === "string") return c.text;
          return JSON.stringify(c);
        })
        .join("\n");
    } else text = JSON.stringify(contentVal ?? "");
    return {
      role,
      content: [{ type: "input_text", text }],
    };
  });
}

function toResponsesPayload(params: { body: any; model: string; stream: boolean }) {
  const body = params.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const inputMessages = toResponsesInput(messages);
  const maxOutputTokens =
    body.max_completion_tokens ??
    body.max_output_tokens ??
    body.max_tokens ??
    120;
  const payload: Record<string, any> = {
    model: params.model,
    input: inputMessages,
    max_output_tokens: maxOutputTokens,
    stream: params.stream || undefined,
    reasoning: maxOutputTokens <= 100 ? { effort: "low" } : normalizeReasoning(body.reasoning),
    text: { format: { type: "text" } },
  };
  if (body.temperature != null) payload.temperature = body.temperature;
  if (body.top_p != null) payload.top_p = body.top_p;
  return payload;
}

function finishReasonFromResponse(event: any): string | null {
  const status = event?.response?.status ?? event?.status;
  const reason =
    event?.response?.status_details?.reason ??
    event?.status_details?.reason ??
    event?.response?.status_reason ??
    null;
  if (reason === "max_output_tokens") return "length";
  if (reason === "stop") return "stop";
  if (status === "completed") return "stop";
  if (status === "incomplete") return "length";
  return null;
}

function collectTextFromEvent(event: any): string[] {
  const texts: string[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.output_text === "string" && node.output_text.trim()) {
      texts.push(node.output_text);
    }
    if (typeof node.output_text_delta === "string" && node.output_text_delta.trim()) {
      texts.push(node.output_text_delta);
    }
    if (node.type === "output_text" && typeof node.text === "string" && node.text.trim()) {
      texts.push(node.text);
    }
    if (Array.isArray(node.content)) {
      node.content.forEach(walk);
    }
    if (Array.isArray(node.contents)) {
      node.contents.forEach(walk);
    }
    if (Array.isArray(node.output)) {
      node.output.forEach(walk);
    }
    if (Array.isArray(node.outputs)) {
      node.outputs.forEach(walk);
    }
    if (Array.isArray(node.messages)) {
      node.messages.forEach(walk);
    }
    if (node.delta) walk(node.delta);
    if (node.output_text) walk(node.output_text);
  };
  walk(event);
  return texts;
}

function chatChunksFromResponsesEvent(event: any, model: string): { sse: string[]; usage: UsageTotals | null } {
  const sse: string[] = [];
  const texts = collectTextFromEvent(event);
  const usage = parseResponsesUsage(event);
  const id = event?.id ?? event?.response?.id ?? `resp-${Date.now()}`;
  const created = event?.created ?? Math.floor(Date.now() / 1000);
  texts.forEach((text, idx) => {
    const delta: Record<string, any> = {};
    if (idx === 0) delta.role = "assistant";
    delta.content = text;
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: null,
        },
      ],
    };
    sse.push(`data: ${JSON.stringify(payload)}\n\n`);
  });
  const finishReason = finishReasonFromResponse(event);
  if (finishReason) {
    sse.push(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`
    );
    sse.push("data: [DONE]\n\n");
  }
  return { sse, usage };
}

async function chatCompletions(params: {
  body: any;
  stream: boolean;
  model: string;
}): Promise<ChatResult> {
  const isGpt5 = params.model.startsWith("gpt-5");
  if (!isGpt5) {
    const payload: Record<string, unknown> = {
      ...params.body,
      model: params.model,
    };

    if (params.stream) {
      payload.stream_options = {
        ...(params.body?.stream_options as Record<string, unknown> | undefined),
        include_usage: true,
      };
    }
    if ((payload as any).reasoning) {
      delete (payload as any).reasoning;
    }

    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: openAiHeaders(),
      body: JSON.stringify(payload),
    });

    if (params.stream) {
      return {
        kind: "stream",
        provider: "openai",
        model: params.model,
        response,
        chunkToSse: (chunk: string) => ({
          sse: [chunk],
          usage: parseOpenAIUsageFromChunk(chunk),
        }),
      };
    }

    const body = await response.json();
    const usage: UsageTotals | null =
      body?.usage != null
        ? {
            prompt_tokens: body.usage.prompt_tokens,
            completion_tokens: body.usage.completion_tokens,
          }
        : null;

    return {
      kind: "json",
      provider: "openai",
      model: params.model,
      status: response.status,
      body,
      usage,
    };
  }

  // GPT-5 models via Responses API
  const payload = toResponsesPayload({
    body: params.body,
    model: params.model,
    stream: params.stream,
  });

  const response = await fetch(RESPONSES_URL, {
    method: "POST",
    headers: openAiHeaders(),
    body: JSON.stringify(payload),
  });

  if (params.stream) {
    // Maintain parser state across chunks
    let buffer = "";
    let roleSent = false;
    let doneSent = false;
    let finishReason: "stop" | "length" | null = null;
    let sawText = false;
    return {
      kind: "stream",
      provider: "openai",
      model: params.model,
      response,
      chunkToSse: (chunk: string) => {
        const sse: string[] = [];
        let usage: UsageTotals | null = null;
        buffer += chunk;
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const rawEvent of events) {
          const lines = rawEvent
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          if (!lines.length) continue;

          let eventType: string | null = null;
          const dataLines: string[] = [];
          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.replace(/^event:\s*/, "");
            } else if (line.startsWith("data:")) {
              dataLines.push(line.replace(/^data:\s*/, ""));
            }
          }
          if (!dataLines.length) continue;

          const payloadStr = dataLines.join("");
          if (payloadStr === "[DONE]") continue;

          let parsed: any = null;
          try {
            parsed = JSON.parse(payloadStr);
          } catch {
            continue;
          }

          const pType = parsed?.type || eventType;
          if (typeof payloadStr === "string" && payloadStr.startsWith("event:")) continue;

          if (pType === "response.output_text.delta" && parsed?.delta != null) {
            if (!roleSent) {
              const roleChunk = {
                id: parsed?.id ?? parsed?.response?.id ?? `resp-${Date.now()}`,
                object: "chat.completion.chunk",
                created: parsed?.created ?? Math.floor(Date.now() / 1000),
                model: params.model,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              };
              sse.push(`data: ${JSON.stringify(roleChunk)}\n\n`);
              roleSent = true;
            }
            const text = String(parsed.delta);
            sawText = true;
            const eventForDelta = {
              id: parsed?.id ?? parsed?.response?.id,
              created: parsed?.created,
              outputs: [
                {
                  type: "message",
                  content: [{ type: "output_text", text }],
                },
              ],
            };
            const converted = chatChunksFromResponsesEvent(eventForDelta, params.model);
            sse.push(...converted.sse);
            if (converted.usage) usage = converted.usage;
          } else if (pType === "response.incomplete") {
            if (parsed?.response?.incomplete_details?.reason === "max_output_tokens") {
              finishReason = "length";
            } else {
              finishReason = "stop";
            }
          } else if (pType === "response.completed") {
            if (!finishReason) finishReason = "stop";
          }
        }

        if (finishReason && !doneSent) {
          const id =
            events.length > 0
              ? (() => {
                  const last = events[events.length - 1];
                  const lines = last.split("\n").map((l) => l.trim());
                  const dataLine = lines.find((l) => l.startsWith("data:"));
                  if (dataLine) {
                    try {
                      const parsed = JSON.parse(dataLine.replace(/^data:\s*/, ""));
                      return parsed?.id ?? parsed?.response?.id ?? `resp-${Date.now()}`;
                    } catch {
                      return `resp-${Date.now()}`;
                    }
                  }
                  return `resp-${Date.now()}`;
                })()
              : `resp-${Date.now()}`;
          const created = Math.floor(Date.now() / 1000);
          if (!sawText) {
            const errPayload = {
              object: "error",
              message: "Upstream returned no text output. Increase max_tokens or lower reasoning effort.",
              code: "OUTPUT_TRUNCATED",
            };
            sse.push(`data: ${JSON.stringify(errPayload)}\n\n`);
          } else {
            const finishChunk = {
              id,
              object: "chat.completion.chunk",
              created,
              model: params.model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            };
            sse.push(`data: ${JSON.stringify(finishChunk)}\n\n`);
          }
          sse.push("data: [DONE]\n\n");
          doneSent = true;
        }

        if (!sse.length) {
          // prevent raw fallback in streamToClient
          sse.push("");
        }
        return { sse, usage };
      },
    };
  }

  const json = await response.json();
  const usage = parseResponsesUsage(json);
  const body = makeChatLikeResponse({ json, model: params.model });
  const assistantText = extractResponseText(json);
  const finishReason = finishReasonFromResponse(json);
  const status =
    assistantText && response.status < 300
      ? response.status
      : finishReason === "length" || finishReason === "incomplete"
        ? 422
        : 502;
  const finalBody =
    assistantText && status < 300
      ? body
      : {
          error: {
            message: "Upstream returned no text output. Increase max_tokens or lower reasoning effort.",
            type: "invalid_request_error",
            code: "OUTPUT_TRUNCATED",
          },
        };
  return {
    kind: "json",
    provider: "openai",
    model: params.model,
    status,
    body: finalBody,
    usage,
  };
}

async function embeddings(): Promise<EmbeddingsResult> {
  throw new Error("OpenAI embeddings not enabled in this sprint");
}

export const openAIAdapter: ProviderAdapter = {
  name: "openai",
  chatCompletions: chatCompletions,
  embeddings,
};
