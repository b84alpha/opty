import fastify, { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { defaultGatewayPort } from "@optyx/shared";
import { prisma } from "./prisma";
import { ApiKeyStatus, Prisma } from "@prisma/client";
import { openAIAdapter } from "./providers/openai";
import { googleAdapter } from "./providers/google";
import { ChatResult, ProviderAdapter, UsageTotals } from "./providers/types";

dotenv.config();

const CHAT_MODEL_PROVIDERS: Record<string, { provider: "openai" | "google" }> = {
  "gpt-5-nano": { provider: "openai" },
  "gpt-5-mini": { provider: "openai" },
  "gemini-2.0-flash-lite": { provider: "google" },
};

const DEFAULT_TIER_MODEL: Record<"FAST" | "SMART", string> = {
  FAST: "gpt-5-nano",
  SMART: "gpt-5-mini",
};

const FAST_FALLBACK_MODEL = "gemini-2.0-flash-lite";
const EMBEDDING_DEFAULT_MODEL = "gemini-embedding-001";
const EMBEDDING_ALLOWED = new Set([EMBEDDING_DEFAULT_MODEL]);

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

const app = fastify({ logger: true });

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

  const price = await prisma.providerModelPrice.findFirst({
    where: { provider, model, isActive: true },
    orderBy: { effectiveFrom: "desc" },
  });

  if (!price) return null;

  const inputCost =
    tokensIn != null ? (Number(price.inputPerMtok) * tokensIn) / 1_000_000 : 0;
  const outputCost =
    tokensOut != null
      ? (Number(price.outputPerMtok) * tokensOut) / 1_000_000
      : 0;
  return inputCost + outputCost;
}

function isFailoverStatus(status: number) {
  return status === 429 || status >= 500 || status === 408;
}

function modelNotAllowedError(resultBody: any) {
  const message: string = resultBody?.error?.message ?? "";
  const type: string = resultBody?.error?.type ?? "";
  if (!resultBody) return false;
  if (type?.toLowerCase().includes("model")) return true;
  if (message.toLowerCase().includes("model")) return true;
  return false;
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
  metadataPatch?: Prisma.InputJsonValue;
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
    metadataPatch,
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
      metadataPatch,
    });
    return reply
      .status(result.response.status)
      .send(responseJson ?? { error: { message: "Upstream error" } });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const reader = result.response.body.getReader();
  const decoder = new TextDecoder();
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        const transformed = result.chunkToSse(chunk);
        for (const sse of transformed.sse) {
          reply.raw.write(sse);
        }
        if (transformed.usage) {
          if (transformed.usage.prompt_tokens != null)
            tokensIn = transformed.usage.prompt_tokens;
          if (transformed.usage.completion_tokens != null)
            tokensOut = transformed.usage.completion_tokens;
        }
      }
    }
  } catch (err) {
    reply.log.error(err);
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
      metadataPatch,
    });
    reply.raw.end();
    return;
  }

  reply.raw.write("data: [DONE]\n\n");
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
    metadataPatch,
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
  metadataPatch?: Prisma.InputJsonValue;
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
    metadataPatch,
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
    metadataPatch,
  });

  reply.status(result.status);
  reply.send(result.body ?? { error: { message: "Upstream error" } });
}

async function start() {
  await app.register(cors, {
    origin: process.env.DASHBOARD_ORIGIN || "http://localhost:3000",
  });

  app.get("/health", async () => {
    return { ok: true };
  });

  app.post(
    "/v1/chat/completions",
    { preHandler: apiKeyPreHandler },
    async (request, reply) => {
      const body = request.body as ChatCompletionBody;

      if (!body || !Array.isArray(body.messages)) {
        return reply.status(400).send({
          error: {
            message: "messages array is required",
            type: "invalid_request_error",
          },
        });
      }

      const routeTagHeader = (request.headers["x-route-tag"] as
        | string
        | undefined)?.toLowerCase();
      const tierHeader = (request.headers["x-optyx-tier"] as
        | string
        | undefined)?.toLowerCase();
      const tier =
        routeTagHeader === "critical" || tierHeader === "smart"
          ? "SMART"
          : "FAST";
      const routeTag =
        routeTagHeader ?? (tier === "SMART" ? "critical" : "fast");

      const requestedModel = body.model as string | undefined;
      const logicalModel =
        requestedModel ??
        (tier === "SMART" ? DEFAULT_TIER_MODEL.SMART : DEFAULT_TIER_MODEL.FAST);

      if (!CHAT_MODEL_PROVIDERS[logicalModel]) {
        return reply.status(400).send({
          error: {
            message:
              "Unsupported model. Allowed: gpt-5-nano, gpt-5-mini, gemini-2.0-flash-lite",
            type: "invalid_request_error",
          },
        });
      }

      if (!request.authContext) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "invalid_request_error",
          },
        });
      }

      const primaryProvider = CHAT_MODEL_PROVIDERS[logicalModel].provider;
      const { id: logId, baseMetadata } = await logRequestStart({
        request,
        projectId: request.authContext.projectId,
        apiKeyId: request.authContext.apiKeyId,
        routeTag,
        tier,
        provider: primaryProvider,
        model: logicalModel,
      });

      const startedAt = new Date();

      // Ensure keys exist before making upstream calls
      if (
        (primaryProvider === "openai" && !process.env.OPENAI_API_KEY) ||
        (primaryProvider === "google" && !process.env.GOOGLE_API_KEY)
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

      const adapter = adapters[primaryProvider];
      let primaryResult: ChatResult | null = null;
      let primaryError: any = null;
      let metadataPatch: Prisma.InputJsonValue | undefined;

      try {
        primaryResult = await adapter.chatCompletions({
          body,
          stream: Boolean(body.stream),
          model: logicalModel,
        });
      } catch (err: any) {
        primaryError = err;
      }

      const fallbackEligible =
        tier === "FAST" && primaryProvider === "openai" && FAST_FALLBACK_MODEL;
      let useFallback = false;
      let fallbackResult: ChatResult | null = null;
      const combinePatch = (next?: Prisma.InputJsonValue) => {
        metadataPatch = mergeInputJson(metadataPatch, next);
      };

      // Determine whether to fallback (only FAST)
      if (
        !primaryResult ||
        (primaryResult.kind === "json" && primaryResult.status >= 400) ||
        (primaryResult.kind === "stream" && !primaryResult.response.ok)
      ) {
        const bodyPayload =
          primaryResult && primaryResult.kind === "json" ? primaryResult.body : null;

        if (
          primaryResult &&
          primaryResult.kind === "json" &&
          primaryResult.status === 400 &&
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

        if (
          fallbackEligible &&
          (primaryError ||
            (primaryResult &&
              primaryResult.kind === "json" &&
              isFailoverStatus(primaryResult.status)) ||
            (primaryResult &&
              primaryResult.kind === "stream" &&
              !primaryResult.response.ok &&
              isFailoverStatus(primaryResult.response.status)))
        ) {
          useFallback = true;
          const primaryStatus =
            primaryResult && primaryResult.kind === "json"
              ? primaryResult.status
              : primaryResult && primaryResult.kind === "stream"
              ? primaryResult.response.status
              : 500;
          const primaryErrorSummary =
            bodyPayload?.error?.message ??
            bodyPayload?.error ??
            primaryError?.message ??
            "unknown";
          combinePatch({
            fallback: {
              from: "openai",
              to: "google",
              primaryStatus,
              primaryError: primaryErrorSummary,
            },
          });

          try {
            fallbackResult = await adapters.google.chatCompletions({
              body,
              stream: Boolean(body.stream),
              model: FAST_FALLBACK_MODEL,
            });
          } catch (err) {
            fallbackResult = null;
          }

          if (!fallbackResult) {
            const finishedAt = new Date();
            await logRequestFinish(logId, baseMetadata, {
              status: "error",
              httpStatus: primaryResult && primaryResult.kind === "json"
                ? primaryResult.status
                : primaryResult && primaryResult.kind === "stream"
                ? primaryResult.response.status
                : 500,
              errorClass: "fallback_failed",
              finishedAt,
              latencyMs: finishedAt.getTime() - startedAt.getTime(),
              fallbackUsed: true,
              retryCount: 1,
              metadataPatch: {
                fallback: {
                  from: "openai",
                  error: bodyPayload?.error ?? primaryError?.message ?? "unknown",
                },
              },
            });
            return reply.status(502).send({
              error: {
                message: "Primary provider failed and fallback unavailable",
                type: "upstream_error",
              },
            });
          }
        } else if (!primaryResult) {
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

      const finalResult = useFallback && fallbackResult ? fallbackResult : primaryResult;
      const providerUsed =
        useFallback && fallbackResult ? fallbackResult.provider : primaryResult?.provider || primaryProvider;
      const modelUsed =
        useFallback && fallbackResult ? fallbackResult.model : logicalModel;
      const retryCount = useFallback ? 1 : 0;

      if (!finalResult) {
        const finishedAt = new Date();
        await logRequestFinish(logId, baseMetadata, {
          status: "error",
          httpStatus: 500,
          errorClass: "upstream_unknown_failure",
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return reply.status(500).send({
          error: { message: "Upstream unavailable", type: "internal_error" },
        });
      }

      if (useFallback) {
        combinePatch({
          fallback: {
            from: primaryProvider,
            reason: "primary_failed",
          },
        });
      }

      if (finalResult.kind === "stream") {
        return streamToClient({
          reply,
          result: finalResult,
          startedAt,
          logId,
          baseMetadata,
          provider: providerUsed,
          model: modelUsed,
          fallbackUsed: useFallback,
          retryCount,
          metadataPatch,
        });
      }

      return handleChatJson({
        reply,
        result: finalResult,
        startedAt,
        logId,
        baseMetadata,
        provider: providerUsed,
        model: modelUsed,
        fallbackUsed: useFallback,
        retryCount,
        metadataPatch,
      });
    }
  );

  app.post(
    "/v1/embeddings",
    { preHandler: apiKeyPreHandler },
    async (request, reply) => {
      const body = request.body as Record<string, any>;
      const model = (body.model as string | undefined) ?? EMBEDDING_DEFAULT_MODEL;
      if (!EMBEDDING_ALLOWED.has(model)) {
        return reply.status(400).send({
          error: {
            message: "Unsupported embedding model. Allowed: gemini-embedding-001",
            type: "invalid_request_error",
          },
        });
      }

      if (!request.authContext) {
        return reply.status(401).send({
          error: { message: "Unauthorized", type: "invalid_request_error" },
        });
      }

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
        provider: "google",
        model,
      });
      const startedAt = new Date();

      let result;
      try {
        result = await googleAdapter.embeddings({ body, model });
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

void start();
