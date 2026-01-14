import { ProviderAdapter, ChatResult, UsageTotals, EmbeddingsResult } from "./types";

const CHAT_URL = "https://api.openai.com/v1/chat/completions";

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

async function chatCompletions(params: {
  body: any;
  stream: boolean;
  model: string;
}): Promise<ChatResult> {
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

async function embeddings(): Promise<EmbeddingsResult> {
  throw new Error("OpenAI embeddings not enabled in this sprint");
}

export const openAIAdapter: ProviderAdapter = {
  name: "openai",
  chatCompletions: chatCompletions,
  embeddings,
};
