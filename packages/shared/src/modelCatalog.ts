export type ModelType = "chat" | "embedding";
export type ModelTier = "FAST" | "SMART";

export type ModelEntry = {
  id: string;
  provider: "openai" | "google";
  type: ModelType;
  tierDefaultAllowed?: ModelTier[];
  maxOutputTokens?: number;
  contextWindow?: number;
};

export const modelCatalog: ModelEntry[] = [
  {
    id: "gpt-5-nano-2025-08-07",
    provider: "openai",
    type: "chat",
    tierDefaultAllowed: ["FAST"],
  },
  {
    id: "gpt-5-mini-2025-08-07",
    provider: "openai",
    type: "chat",
    tierDefaultAllowed: ["SMART"],
  },
  {
    id: "gpt-4o-2024-08-06",
    provider: "openai",
    type: "chat",
  },
  {
    id: "gemini-2.0-flash-lite",
    provider: "google",
    type: "chat",
    tierDefaultAllowed: ["FAST"],
  },
  {
    id: "gemini-embedding-001",
    provider: "google",
    type: "embedding",
  },
];

export const defaultFastModelId = "gpt-5-nano-2025-08-07";
export const defaultSmartModelId = "gpt-5-mini-2025-08-07";

export const modelAliases: Record<string, string> = {
  "gpt-5-nano": defaultFastModelId,
  "gpt-5-mini": defaultSmartModelId,
};
