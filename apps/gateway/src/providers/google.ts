import { ProviderAdapter, ChatResult, EmbeddingsResult } from "./types";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const CHAT_MODELS: Record<string, string> = {
  "gemini-2.0-flash-lite": "gemini-2.0-flash-lite",
};

const EMBEDDING_MODELS: Record<string, string> = {
  "gemini-embedding-001": "gemini-embedding-001",
};

function googleHeaders() {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error("GOOGLE_API_KEY is not set");
  }
  return key;
}

function mapMessagesToContents(
  messages: Array<{ role?: string; content?: any }>
): any[] {
  return messages.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }],
  }));
}

function googleToOpenAIResponse(json: any, model: string) {
  const text =
    json?.candidates?.[0]?.content?.parts
      ?.map((p: any) => p?.text || "")
      .join("") ?? "";
  return {
    id: `google-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: json?.usage ?? {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
    },
  };
}

async function chatCompletions(params: {
  body: any;
  stream: boolean;
  model: string;
}): Promise<ChatResult> {
  const upstreamModel = CHAT_MODELS[params.model];
  if (!upstreamModel) {
    throw new Error("Unsupported Google logical model");
  }

  const key = googleHeaders();
  const contents = mapMessagesToContents(params.body?.messages ?? []);
  const url = `${GOOGLE_API_BASE}/models/${encodeURIComponent(
    upstreamModel
  )}:${params.stream ? "streamGenerateContent" : "generateContent"}?key=${key}`;

  const payload = {
    contents,
    generationConfig: {
      temperature: params.body?.temperature,
      maxOutputTokens: params.body?.max_tokens,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (params.stream) {
    return {
      kind: "stream",
      provider: "google",
      model: params.model,
      response,
      chunkToSse: (chunk: string) => {
        const sse: string[] = [];
        const lines = chunk
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            const text =
              parsed?.candidates?.[0]?.content?.parts
                ?.map((p: any) => p?.text || "")
                .join("") ?? "";
            if (text) {
              const payload = {
                id: `google-${Date.now()}`,
                object: "chat.completion.chunk",
                model: params.model,
                choices: [
                  {
                    index: 0,
                    delta: { content: text },
                    finish_reason: null,
                  },
                ],
              };
              sse.push(`data: ${JSON.stringify(payload)}\n\n`);
            }
          } catch {
            // ignore malformed fragments
          }
        }
        return { sse, usage: null };
      },
    };
  }

  const json = await response.json();
  return {
    kind: "json",
    provider: "google",
    model: params.model,
    status: response.status,
    body: googleToOpenAIResponse(json, params.model),
    usage: json?.usage ?? null,
  };
}

async function embeddings(params: { body: any; model: string }): Promise<EmbeddingsResult> {
  const upstreamModel = EMBEDDING_MODELS[params.model];
  if (!upstreamModel) {
    throw new Error("Unsupported Google embedding model");
  }
  const key = googleHeaders();
  const rawInput = params.body?.input;
  const inputs: string[] = Array.isArray(rawInput)
    ? rawInput.map((val) => String(val ?? ""))
    : [String(rawInput ?? "")];

  const results = await Promise.all(
    inputs.map(async (text) => {
      const url = `${GOOGLE_API_BASE}/models/${encodeURIComponent(
        upstreamModel
      )}:embedContent?key=${key}`;
      const payload = {
        content: {
          parts: [
            {
              text,
            },
          ],
        },
      };
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json();
      if (!response.ok) {
        throw new Error(
          json?.error?.message || `Embedding request failed with status ${response.status}`
        );
      }
      const embedding = json?.embedding?.values ?? [];
      return { embedding, usage: json?.usage };
    })
  );

  const data = results.map((item, index) => ({
    object: "embedding",
    embedding: item.embedding,
    index,
  }));

  const approximateTokens = inputs.reduce((acc, text) => acc + Math.max(1, Math.round(text.length / 4)), 0);
  const usage = {
    prompt_tokens: approximateTokens,
    completion_tokens: 0,
    total_tokens: approximateTokens,
  };

  const body = {
    object: "list",
    data,
    model: params.model,
    usage,
  };

  return {
    provider: "google",
    model: params.model,
    status: 200,
    body,
    usage,
  };
}

export const googleAdapter: ProviderAdapter = {
  name: "google",
  chatCompletions,
  embeddings,
};
