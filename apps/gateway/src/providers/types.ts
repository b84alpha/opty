import { FastifyReply } from "fastify";

export type UsageTotals = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
};

export type ChatStreamResult = {
  kind: "stream";
  provider: "openai" | "google";
  model: string;
  response: Response;
  /**
   * Converts upstream chunk text into one or more SSE payload strings.
   * These payloads should already include the `data:` prefix and double newline terminators.
   */
  chunkToSse: (chunk: string) => { sse: string[]; usage?: UsageTotals | null };
};

export type ChatJsonResult = {
  kind: "json";
  provider: "openai" | "google";
  model: string;
  status: number;
  body: any;
  usage?: UsageTotals | null;
};

export type ChatResult = ChatStreamResult | ChatJsonResult;

export type EmbeddingsResult = {
  provider: "openai" | "google";
  model: string;
  status: number;
  body: any;
  usage?: UsageTotals | null;
};

export interface ProviderAdapter {
  name: "openai" | "google";
  chatCompletions(params: {
    body: any;
    stream: boolean;
    model: string;
  }): Promise<ChatResult>;
  embeddings(params: { body: any; model: string }): Promise<EmbeddingsResult>;
}
