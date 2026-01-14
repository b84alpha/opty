import fastify, { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import crypto from "crypto";
import {
  defaultGatewayPort,
  modelCatalog,
  defaultFastModelId,
  defaultSmartModelId,
  ModelEntry,
  modelAliases,
} from "@optyx/shared";
import { prisma } from "./prisma";
import { ApiKeyStatus, Prisma } from "@prisma/client";
import { openAIAdapter } from "./providers/openai";
import { googleAdapter } from "./providers/google";
import { ChatResult, ProviderAdapter } from "./providers/types";

dotenv.config();

const modelCatalogById = new Map(modelCatalog.map((m) => [m.id, m]));
const chatModelIds = modelCatalog.filter((m) => m.type === "chat").map((m) => m.id);
const embeddingModelIds = modelCatalog.filter((m) => m.type === "embedding").map((m) => m.id);
const EMBEDDING_DEFAULT_MODEL = "gemini-embedding-001";
const aliasReverseLookup = Object.entries(modelAliases).reduce<Record<string, string[]>>((acc, [alias, target]) => {
  if (!acc[target]) acc[target] = [];
  acc[target].push(alias);
  return acc;
}, {});

const adapters: Record<"openai" | "google", ProviderAdapter> = {
  openai: openAIAdapter,
  google: googleAdapter,
};

declare module "fastify" {
  interface FastifyRequest {
    authContext?: {
      apiKeyId: string;
      projectId: string;
      apiKeyPrefix: string;
    };
  }
}

type ChatCompletionBody = {
  model?: string;
  messages: Array<Record<string, unknown>>;
  stream?: boolean;
  [key: string]: unknown;
};

function hashApiKey(key: string) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function extractApiKey(req: FastifyRequest): string | null {
  const headerKey = (req.headers["x-api-key"] as string | undefined)?.trim();
  const authHeader = req.headers.authorization;

  if (headerKey) return headerKey;
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) return token.trim();
    if (!token && scheme) return scheme.trim();
  }
  return null;
}

async function apiKeyPreHandler(req: FastifyRequest, reply: FastifyReply) {
  const presentedKey = extractApiKey(req);
  if (!presentedKey) {
    return reply.status(401).send({
      error: {
        message: "Incorrect API key provided",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
  }

  const hashed = hashApiKey(presentedKey);
  const apiKey = await prisma.apiKey.findFirst({
    where: { hashedKey: hashed },
    select: { id: true, status: true, projectId: true, prefix: true },
  });

  if (!apiKey || apiKey.status !== ApiKeyStatus.ACTIVE) {
    return reply.status(401).send({
      error: {
        message: "Incorrect API key provided",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    });
  }

  req.authContext = {
    apiKeyId: apiKey.id,
    projectId: apiKey.projectId,
    apiKeyPrefix: apiKey.prefix,
  };

  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });
}

type ProjectSettings = {
  id: string;
  defaultTier: "FAST" | "SMART";
  allowedChatModels: Set<string>;
  allowedEmbeddingModels: Set<string>;
};

function normalizeTier(input?: string | null): "FAST" | "SMART" {
  if (!input) return "FAST";
  const value = input.toLowerCase();
  if (value === "smart") return "SMART";
  return "FAST";
}

function normalizeModelId(input?: string | null) {
  if (!input) return { canonical: null, aliasOf: null };
  const canonical = modelAliases[input] ?? input;
  const aliasOf = modelAliases[input] ? canonical : null;
  return { canonical, aliasOf };
}

function getAllowedModelsSet(project: { allowedModels: any; allowAllModels: boolean }, type: "chat" | "embedding") {
  if (project.allowAllModels) {
    return new Set(type === "chat" ? chatModelIds : embeddingModelIds);
  }
  if (Array.isArray(project.allowedModels)) {
    const normalized = (project.allowedModels as any[])
      .map((v) => (typeof v === "string" ? v : null))
      .filter((v): v is string => Boolean(v))
      .map((v) => normalizeModelId(v).canonical)
      .filter((v): v is string => Boolean(v))
      .filter((v) => (type === "chat" ? chatModelIds.includes(v) : embeddingModelIds.includes(v)));
    return new Set(normalized);
  }
  return new Set<string>();
}

async function getProjectSettings(projectId: string): Promise<ProjectSettings | null> {
  const project = (await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, defaultTier: true, allowedModels: true, allowAllModels: true } as any,
  })) as any;
  if (!project) return null;
  return {
    id: project.id,
    defaultTier: normalizeTier(project.defaultTier),
    allowedChatModels: getAllowedModelsSet(project, "chat"),
    allowedEmbeddingModels: getAllowedModelsSet(project, "embedding"),
  };
}

async function logRequestStart(params: {
  request: FastifyRequest;
  projectId: string;
  apiKeyId: string;
  routeTag: string | null;
  tier: string;
  provider: "openai" | "google";
  model: string;
}) {
  const metadata: Prisma.InputJsonValue = {
    ip: params.request.ip,
    userAgent: params.request.headers["user-agent"] || "",
    routeTag: params.routeTag,
    tier: params.tier,
  };

  const log = await prisma.requestsLog.create({
    data: {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      routeTag: params.routeTag ?? undefined,
      tier: params.tier,
      provider: params.provider,
      model: params.model,
      status: "in_progress",
      metadata,
    },
  });

  return { id: log.id, baseMetadata: metadata };
}

function mergeInputJson(
  base?: Prisma.InputJsonValue,
  patch?: Prisma.InputJsonValue
): Prisma.InputJsonValue | undefined {
  const safeBase =
    base && typeof base === "object" && !Array.isArray(base) ? base : {};
  const safePatch =
    patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const merged = {
    ...(safeBase as Record<string, unknown>),
    ...(safePatch as Record<string, unknown>),
  };
  return Object.keys(merged).length ? (merged as Prisma.InputJsonValue) : undefined;
}

async function logRequestFinish(
  id: string,
  baseMetadata: Prisma.InputJsonValue,
  data: {
    status: string;
    httpStatus?: number;
    errorClass?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    estimatedCostUsdc?: number | null;
    finishedAt?: Date;
    latencyMs?: number;
    provider?: string;
    model?: string;
    fallbackUsed?: boolean;
    retryCount?: number;
    metadataPatch?: Prisma.InputJsonValue;
  }
) {
  const metadata = mergeInputJson(baseMetadata, data.metadataPatch);

  const updateData: Prisma.RequestsLogUpdateInput = {
    status: data.status,
    httpStatus: data.httpStatus,
    errorClass: data.errorClass ?? undefined,
    tokensIn: data.tokensIn ?? undefined,
    tokensOut: data.tokensOut ?? undefined,
    estimatedCostUsdc: data.estimatedCostUsdc ?? undefined,
    finishedAt: data.finishedAt,
    latencyMs: data.latencyMs,
    provider: data.provider ?? undefined,
    model: data.model ?? undefined,
    fallbackUsed: data.fallbackUsed ?? undefined,
    retryCount: data.retryCount ?? undefined,
    metadata: metadata as any,
  };

  await prisma.requestsLog.update({
    where: { id },
    data: updateData,
  });
}

async function calculateCost(params: {
  provider: string;
  model: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
}) {
  const { provider, model, tokensIn, tokensOut } = params;
  if (tokensIn == null && tokensOut == null) return null;

  let price = await prisma.providerModelPrice.findFirst({
    where: { provider, model, isActive: true },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!price && aliasReverseLookup[model]) {
    for (const alias of aliasReverseLookup[model]) {
      price = await prisma.providerModelPrice.findFirst({
        where: { provider, model: alias, isActive: true },
        orderBy: { effectiveFrom: "desc" },
      });
      if (price) break;
    }
  }

  if (!price) return null;

  const inputCost =
    tokensIn != null ? (Number(price.inputPerMtok) * tokensIn) / 1_000_000 : 0;
  const outputCost =
    tokensOut != null
      ? (Number(price.outputPerMtok) * tokensOut) / 1_000_000
      : 0;
  return inputCost + outputCost;
}

function modelNotAllowedError(resultBody: any) {
  const message: string = resultBody?.error?.message ?? "";
  const type: string = resultBody?.error?.type ?? "";
  if (!resultBody) return false;
  if (type?.toLowerCase().includes("model")) return true;
  if (message.toLowerCase().includes("model")) return true;
  return false;
}

function ensureModelAllowed(
  modelId: string,
  allowedModels: Set<string>,
  type: "chat" | "embedding",
  reply: FastifyReply
) {
  const entry = modelCatalogById.get(modelId);
  if (!entry || entry.type !== type || !allowedModels.has(modelId)) {
    reply.status(400).send({
      error: {
        message: "model not allowed/available",
        type: "invalid_request_error",
        code: "MODEL_NOT_ALLOWED",
      },
    });
    return null;
  }
  return entry;
}

function makeMockStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockChatResult(params: { stream: boolean; model: string; provider: "openai" | "google" }): ChatResult {
  if (params.stream) {
    const chunks = [
      `data: ${JSON.stringify({
        id: "mock-chat",
        object: "chat.completion.chunk",
        model: params.model,
        choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const response = makeMockStreamResponse(chunks);
    return {
      kind: "stream",
      provider: params.provider,
      model: params.model,
      response,
      chunkToSse: (chunk: string) => ({ sse: [chunk], usage: null }),
    };
  }

  return {
    kind: "json",
    provider: params.provider,
    model: params.model,
    status: 200,
    body: {
      id: "mock-chat",
      object: "chat.completion",
      model: params.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
      },
    },
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  };
}

function mockEmbeddings(model: string) {
  return {
    provider: "google" as const,
    model,
    status: 200,
    body: {
      object: "list",
      data: [
        {
          object: "embedding",
          embedding: [0.1, 0.2, 0.3],
          index: 0,
        },
      ],
      model,
      usage: { prompt_tokens: 5, total_tokens: 5 },
    },
    usage: { prompt_tokens: 5, completion_tokens: 0 },
  };
}
async function streamToClient(params: {
  reply: FastifyReply;
  result: Extract<ChatResult, { kind: "stream" }>;
  startedAt: Date;
  logId: string;
  baseMetadata: Prisma.InputJsonValue;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  retryCount: number;
}) {
  const {
    reply,
    result,
    startedAt,
    logId,
    baseMetadata,
    provider,
    model,
    fallbackUsed,
    retryCount,
  } = params;

  if (!result.response.ok || !result.response.body) {
    let responseJson: any = null;
    try {
      responseJson = await result.response.json();
    } catch {
      // ignore
    }
    const finishedAt = new Date();
    await logRequestFinish(logId, baseMetadata, {
      status: "error",
      httpStatus: result.response.status,
      errorClass: responseJson?.error?.type ?? "upstream_error",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
      provider,
      model,
      fallbackUsed,
      retryCount,
    });
    return reply
      .status(result.response.status)
      .send(responseJson ?? { error: { message: "Upstream error" } });
  }

  const resolvedHeader = reply.getHeader("x-optyx-resolved-model");
  const streamHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
  if (resolvedHeader != null) {
    streamHeaders["x-optyx-resolved-model"] = String(resolvedHeader);
  }
  reply.raw.writeHead(200, streamHeaders);
  if (typeof reply.raw.flushHeaders === "function") {
    reply.raw.flushHeaders();
  }
  // Send an initial empty chunk to ensure clients receive data promptly
  const initialChunk = {
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
  reply.raw.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

  const reader = result.response.body.getReader();
  const decoder = new TextDecoder();
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let hasSentDone = false;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        let transformed = result.chunkToSse(chunk);
        if (!transformed.sse.length && chunk.trim()) {
          transformed = {
            sse: [`data: ${chunk.trim()}\n\n`],
            usage: transformed.usage,
          };
        }
        const rewrittenSse: string[] = [];
        for (const sse of transformed.sse) {
          if (sse.trim().startsWith("data:") && !sse.includes("[DONE]")) {
            const raw = sse.replace(/^data:\s*/, "").trim();
            try {
              const parsed = JSON.parse(raw);
              parsed.model = model;
              rewrittenSse.push(`data: ${JSON.stringify(parsed)}\n\n`);
            } catch {
              rewrittenSse.push(sse);
            }
          } else {
            rewrittenSse.push(sse);
          }
        }
        for (const sse of rewrittenSse) {
          reply.raw.write(sse);
          if (sse.includes("[DONE]")) hasSentDone = true;
        }
        if (transformed.usage) {
          if (transformed.usage.prompt_tokens != null) tokensIn = transformed.usage.prompt_tokens;
          if (transformed.usage.completion_tokens != null) tokensOut = transformed.usage.completion_tokens;
        }
        if (!hasSentDone && chunk.includes("[DONE]")) {
          hasSentDone = true;
        }
      }
    }
  } catch (err) {
    reply.log.error(err);
    reply.raw.write(
      `data: ${JSON.stringify({
        object: "error",
        message: "stream_failed",
      })}\n\n`
    );
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
    const finishedAt = new Date();
    await logRequestFinish(logId, baseMetadata, {
      status: "error",
      httpStatus: 500,
      errorClass: "stream_failed",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
      provider,
      model,
      fallbackUsed,
      retryCount,
    });
    return;
  }

  if (!hasSentDone) {
    reply.raw.write("data: [DONE]\n\n");
  }
  reply.raw.end();

  const finishedAt = new Date();
  const estimatedCostUsdc = await calculateCost({
    provider,
    model,
    tokensIn,
    tokensOut,
  });

  await logRequestFinish(logId, baseMetadata, {
    status: "success",
    httpStatus: 200,
    tokensIn,
    tokensOut,
    estimatedCostUsdc,
    finishedAt,
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
    provider,
    model,
    fallbackUsed,
    retryCount,
  });
}

async function handleChatJson(params: {
  reply: FastifyReply;
  result: Extract<ChatResult, { kind: "json" }>;
  startedAt: Date;
  logId: string;
  baseMetadata: Prisma.InputJsonValue;
  provider: string;
  model: string;
  fallbackUsed: boolean;
  retryCount: number;
}) {
  const {
    reply,
    result,
    startedAt,
    logId,
    baseMetadata,
    provider,
    model,
    fallbackUsed,
    retryCount,
  } = params;

  const finishedAt = new Date();
  const latencyMs = finishedAt.getTime() - startedAt.getTime();
  const tokensIn = result.usage?.prompt_tokens ?? null;
  const tokensOut = result.usage?.completion_tokens ?? null;
  const estimatedCostUsdc = await calculateCost({
    provider,
    model,
    tokensIn,
    tokensOut,
  });

  await logRequestFinish(logId, baseMetadata, {
    status: result.status >= 200 && result.status < 300 ? "success" : "error",
    httpStatus: result.status,
    errorClass:
      result.status >= 200 && result.status < 300
        ? null
        : result.body?.error?.type ?? "upstream_error",
    tokensIn,
    tokensOut,
    estimatedCostUsdc,
    finishedAt,
    latencyMs,
    provider,
    model,
    fallbackUsed,
    retryCount,
  });

  const responseBody =
    result.body != null && typeof result.body === "object"
      ? { ...result.body, model }
      : result.body ?? { error: { message: "Upstream error" } };

  reply.status(result.status);
  reply.send(responseBody);
}

function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/models", async (request, reply) => {
    const tierFilter = (request.query as any)?.tier
      ? String((request.query as any).tier).toUpperCase()
      : undefined;
    const providerFilter = (request.query as any)?.provider
      ? String((request.query as any).provider).toLowerCase()
      : undefined;

    const data: any[] = modelCatalog
      .filter((m) => {
        if (tierFilter && m.tierDefaultAllowed && !m.tierDefaultAllowed.includes(tierFilter as any)) return false;
        if (providerFilter && m.provider !== providerFilter) return false;
        return true;
      })
      .map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "optyx",
        provider: m.provider,
        type: m.type,
        tierDefaultAllowed: m.tierDefaultAllowed,
      }));

    // Add alias entries
    Object.entries(modelAliases).forEach(([alias, target]) => {
      const entry = modelCatalogById.get(target);
      if (!entry) return;
      if (tierFilter && entry.tierDefaultAllowed && !entry.tierDefaultAllowed.includes(tierFilter as any)) return;
      if (providerFilter && entry.provider !== providerFilter) return;
      data.push({
        id: alias,
        object: "model",
        owned_by: "alias",
        provider: entry.provider,
        type: entry.type,
        tierDefaultAllowed: entry.tierDefaultAllowed,
        alias_for: target,
      });
    });

    reply.send({ object: "list", data });
  });

  app.post(
    "/v1/chat/completions",
    { preHandler: apiKeyPreHandler },
    async (request, reply) => {
      if (!request.authContext) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "invalid_request_error",
          },
        });
      }
      const body = request.body as ChatCompletionBody;

      if (!body || !Array.isArray(body.messages)) {
        return reply.status(400).send({
          error: {
            message: "messages array is required",
            type: "invalid_request_error",
          },
        });
      }

      const routeTagHeader = (request.headers["x-route-tag"] as string | undefined)?.toLowerCase();
      const tierHeader = (request.headers["x-optyx-tier"] as string | undefined)?.toLowerCase();

      const projectSettings = await getProjectSettings(request.authContext.projectId);
      if (!projectSettings) {
        return reply.status(404).send({ error: { message: "Project not found" } });
      }

      const tier = tierHeader === "smart" || routeTagHeader === "critical" ? "SMART" : projectSettings.defaultTier;
      const routeTag = routeTagHeader ?? (tier === "SMART" ? "critical" : "fast");

      const requestedModel = body.model as string | undefined;
      const allowedModels = projectSettings.allowedChatModels;
      const { canonical: resolvedModel, aliasOf } = normalizeModelId(requestedModel);

      let provider: "openai" | "google";
      let logicalModel: string;
      let modelEntry: ModelEntry | null = null;

      if (requestedModel) {
        if (!resolvedModel) {
          return reply.status(400).send({
            error: {
              message: "model not allowed/available",
              type: "invalid_request_error",
              code: "MODEL_NOT_ALLOWED",
            },
          });
        }
        logicalModel = resolvedModel;
        modelEntry = modelCatalogById.get(logicalModel) || null;
        if (!modelEntry || modelEntry.type !== "chat" || !allowedModels.has(logicalModel)) {
          return reply.status(400).send({
            error: {
              message: "model not allowed/available",
              type: "invalid_request_error",
              code: "MODEL_NOT_ALLOWED",
            },
          });
        }
        provider = modelEntry.provider;
      } else {
        logicalModel = tier === "SMART" ? defaultSmartModelId : defaultFastModelId;
        modelEntry = ensureModelAllowed(logicalModel, allowedModels, "chat", reply);
        if (!modelEntry) return;
        provider = modelEntry.provider;
      }

      reply.header("x-optyx-resolved-model", aliasOf ? resolvedModel : logicalModel);

      const upstreamBody = { ...body, model: logicalModel };

      const { id: logId, baseMetadata } = await logRequestStart({
        request,
        projectId: request.authContext.projectId,
        apiKeyId: request.authContext.apiKeyId,
        routeTag,
        tier,
        provider,
        model: logicalModel,
      });

      const startedAt = new Date();

      if (
        (provider === "openai" && !process.env.OPENAI_API_KEY) ||
        (provider === "google" && !process.env.GOOGLE_API_KEY)
      ) {
        const finishedAt = new Date();
        await logRequestFinish(logId, baseMetadata, {
          status: "error",
          httpStatus: 500,
          errorClass: "missing_provider_api_key",
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return reply.status(500).send({
          error: {
            message: "Provider API key is not configured",
            type: "config_error",
          },
        });
      }

      const adapter = adapters[provider];
      let primaryResult: ChatResult | null = null;

      if (process.env.GATEWAY_MOCK === "1" && upstreamBody.stream) {
        // Manual streaming for mock mode to ensure chunks precede [DONE]
        const resolvedHeader = reply.getHeader("x-optyx-resolved-model");
        const streamHeaders: Record<string, string> = {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        };
        if (resolvedHeader != null) {
          streamHeaders["x-optyx-resolved-model"] = String(resolvedHeader);
        }
        reply.raw.writeHead(200, streamHeaders);
        if (typeof reply.raw.flushHeaders === "function") {
          reply.raw.flushHeaders();
        }
        const chunk1 = {
          id: "mock-chat",
          object: "chat.completion.chunk",
          model: logicalModel,
          choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }],
        };
        const chunk2 = {
          id: "mock-chat",
          object: "chat.completion.chunk",
          model: logicalModel,
          choices: [{ index: 0, delta: { content: "B" }, finish_reason: null }],
        };
        const chunk3 = {
          id: "mock-chat",
          object: "chat.completion.chunk",
          model: logicalModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        const flush = () => {
          if (typeof (reply.raw as any).flush === "function") {
            (reply.raw as any).flush();
          }
        };
        reply.raw.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        flush();
        await new Promise((r) => setTimeout(r, 5));
        reply.raw.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        flush();
        await new Promise((r) => setTimeout(r, 5));
        reply.raw.write(`data: ${JSON.stringify(chunk3)}\n\n`);
        flush();
        await new Promise((r) => setTimeout(r, 5));
        reply.raw.write("data: [DONE]\n\n");
        flush();
        reply.raw.end();

        const finishedAt = new Date();
        await logRequestFinish(logId, baseMetadata, {
          status: "success",
          httpStatus: 200,
          tokensIn: 5,
          tokensOut: 3,
          estimatedCostUsdc: await calculateCost({
            provider,
            model: logicalModel,
            tokensIn: 5,
            tokensOut: 3,
          }),
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
          provider,
          model: logicalModel,
          fallbackUsed: false,
          retryCount: 0,
        });
        return;
      }

      if (process.env.GATEWAY_MOCK === "1") {
        primaryResult = mockChatResult({
          stream: Boolean(upstreamBody.stream),
          model: logicalModel,
          provider,
        });
      } else {
        try {
          primaryResult = await adapter.chatCompletions({
            body: upstreamBody,
            stream: Boolean(upstreamBody.stream),
            model: logicalModel,
          });
        } catch (err: any) {
          const finishedAt = new Date();
          await logRequestFinish(logId, baseMetadata, {
            status: "error",
            httpStatus: 500,
            errorClass: "upstream_fetch_failed",
            finishedAt,
            latencyMs: finishedAt.getTime() - startedAt.getTime(),
          });
          return reply.status(500).send({
            error: {
              message: "Upstream request failed",
              type: "internal_error",
            },
          });
        }
      }

      const providerUsed = primaryResult.provider || provider;
      const modelUsed = logicalModel;
      const retryCount = 0;
      const fallbackUsed = false;

      if (
        primaryResult.kind === "json" &&
        primaryResult.status >= 400 &&
        primaryResult.status < 500 &&
        modelNotAllowedError(primaryResult.body)
      ) {
        const finishedAt = new Date();
        await logRequestFinish(logId, baseMetadata, {
          status: "error",
          httpStatus: primaryResult.status,
          errorClass: "MODEL_NOT_ALLOWED",
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return reply.status(400).send({
          error: {
            message: "Requested model is not allowed by upstream provider",
            type: "invalid_request_error",
            code: "MODEL_NOT_ALLOWED",
          },
        });
      }

      if (primaryResult.kind === "stream") {
        return streamToClient({
          reply,
          result: primaryResult,
          startedAt,
          logId,
          baseMetadata,
          provider: providerUsed,
          model: modelUsed,
          fallbackUsed,
          retryCount,
        });
      }

      return handleChatJson({
        reply,
        result: primaryResult,
        startedAt,
        logId,
        baseMetadata,
        provider: providerUsed,
        model: modelUsed,
        fallbackUsed,
        retryCount,
      });
    }
  );

  app.post(
    "/v1/embeddings",
    { preHandler: apiKeyPreHandler },
    async (request, reply) => {
      if (!request.authContext) {
        return reply.status(401).send({
          error: { message: "Unauthorized", type: "invalid_request_error" },
        });
      }
      const body = request.body as Record<string, any>;
      const model = (body.model as string | undefined) ?? EMBEDDING_DEFAULT_MODEL;

      const projectSettings = await getProjectSettings(request.authContext.projectId);
      if (!projectSettings) {
        return reply.status(404).send({ error: { message: "Project not found" } });
      }

      const embeddingAllowed = ensureModelAllowed(
        model,
        projectSettings.allowedEmbeddingModels,
        "embedding",
        reply
      );
      if (!embeddingAllowed) return;

      if (!process.env.GOOGLE_API_KEY) {
        return reply.status(500).send({
          error: { message: "GOOGLE_API_KEY is not configured", type: "config_error" },
        });
      }

      const { id: logId, baseMetadata } = await logRequestStart({
        request,
        projectId: request.authContext.projectId,
        apiKeyId: request.authContext.apiKeyId,
        routeTag: "embeddings",
        tier: "EMBEDDINGS",
        provider: embeddingAllowed.provider,
        model,
      });
      const startedAt = new Date();

      let result;
      try {
        if (process.env.GATEWAY_MOCK === "1") {
          result = mockEmbeddings(model);
        } else {
          result = await googleAdapter.embeddings({ body, model });
        }
      } catch (err: any) {
        const finishedAt = new Date();
        await logRequestFinish(logId, baseMetadata, {
          status: "error",
          httpStatus: 500,
          errorClass: "embeddings_failed",
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return reply.status(500).send({
          error: { message: "Embeddings request failed", type: "internal_error" },
        });
      }

      const finishedAt = new Date();
      const latencyMs = finishedAt.getTime() - startedAt.getTime();
      const tokensIn = result.usage?.prompt_tokens ?? null;
      const tokensOut = result.usage?.completion_tokens ?? null;
      const estimatedCostUsdc = await calculateCost({
        provider: result.provider,
        model: result.model,
        tokensIn,
        tokensOut,
      });

      await logRequestFinish(logId, baseMetadata, {
        status: result.status >= 200 && result.status < 300 ? "success" : "error",
        httpStatus: result.status,
        errorClass: result.status >= 200 && result.status < 300 ? null : "upstream_error",
        tokensIn,
        tokensOut,
        estimatedCostUsdc,
        finishedAt,
        latencyMs,
        provider: result.provider,
        model: result.model,
      });

      reply.status(result.status).send(result.body);
    }
  );
}

export function buildApp() {
  const app = fastify({ logger: true });
  app.register(cors, {
    origin: process.env.DASHBOARD_ORIGIN || "http://localhost:3000",
  });
  registerRoutes(app);
  return app;
}

async function start() {
  const app = buildApp();
  const port = Number(process.env.GATEWAY_PORT || defaultGatewayPort);
  const host = process.env.GATEWAY_HOST || "0.0.0.0";

  try {
    await app.listen({ port, host });
    app.log.info(`Gateway listening on http://${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (require.main === module) {
  void start();
}
