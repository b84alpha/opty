import fastify, { FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { defaultGatewayPort } from "@optyx/shared";
import { prisma } from "./prisma";
import { ApiKeyStatus, Prisma } from "@prisma/client";

dotenv.config();

const ALLOWED_MODELS = ["gpt-5-nano", "gpt-5-mini"] as const;
type AllowedModel = (typeof ALLOWED_MODELS)[number];

// Map internal model names to upstream OpenAI models.
const MODEL_MAP: Record<AllowedModel, string> = {
  "gpt-5-nano": "gpt-4o-mini",
  "gpt-5-mini": "gpt-4o",
};

const OPENAI_API_BASE = "https://api.openai.com/v1/chat/completions";

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
    // Allow raw key in Authorization without Bearer prefix.
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

async function logRequestStart(params: {
  request: FastifyRequest;
  projectId: string;
  apiKeyId: string;
  routeTag: string | null;
  tier: string;
  model: AllowedModel;
}) {
  const metadata: Prisma.InputJsonValue = {
    ip: params.request.ip,
    userAgent: params.request.headers["user-agent"] || "",
    routeTag: params.routeTag,
    tier: params.tier,
  };

  return prisma.requestsLog.create({
    data: {
      projectId: params.projectId,
      apiKeyId: params.apiKeyId,
      routeTag: params.routeTag ?? undefined,
      tier: params.tier,
      provider: "openai",
      model: params.model,
      status: "in_progress",
      metadata,
    },
  });
}

async function logRequestFinish(
  id: string,
  data: {
    status: string;
    httpStatus?: number;
    errorClass?: string | null;
    tokensIn?: number | null;
    tokensOut?: number | null;
    estimatedCostUsdc?: number | null;
    finishedAt?: Date;
    latencyMs?: number;
  }
) {
  const updateData: Prisma.RequestsLogUpdateInput = {
    status: data.status,
    httpStatus: data.httpStatus,
    errorClass: data.errorClass ?? undefined,
    tokensIn: data.tokensIn ?? undefined,
    tokensOut: data.tokensOut ?? undefined,
    estimatedCostUsdc: data.estimatedCostUsdc ?? undefined,
    finishedAt: data.finishedAt,
    latencyMs: data.latencyMs,
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
    tokensIn != null
      ? (Number(price.inputPerMtok) * tokensIn) / 1_000_000
      : 0;
  const outputCost =
    tokensOut != null
      ? (Number(price.outputPerMtok) * tokensOut) / 1_000_000
      : 0;
  return inputCost + outputCost;
}

function parseUsageFromChunk(
  chunk: string
): { prompt_tokens?: number; completion_tokens?: number } | null {
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

async function handleNonStreaming(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  logId: string;
  logicalModel: AllowedModel;
  payload: Record<string, unknown>;
  startedAt: Date;
}) {
  const { request, reply, logId, logicalModel, payload, startedAt } = params;

  let upstreamResponse: any;
  try {
    upstreamResponse = await fetch(OPENAI_API_BASE, {
      method: "POST",
      headers: openAiHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const finishedAt = new Date();
    await logRequestFinish(logId, {
      status: "error",
      httpStatus: 500,
      errorClass: "upstream_fetch_failed",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
    });
    request.log.error(err);
    return reply.status(500).send({
      error: {
        message: "Upstream request failed",
        type: "internal_error",
      },
    });
  }

  const finishedAt = new Date();
  const latencyMs = finishedAt.getTime() - startedAt.getTime();
  let responseJson: any = null;

  try {
    responseJson = await upstreamResponse.json();
  } catch (err) {
    request.log.error(err);
  }

  const tokensIn = responseJson?.usage?.prompt_tokens ?? null;
  const tokensOut = responseJson?.usage?.completion_tokens ?? null;
  const estimatedCostUsdc = await calculateCost({
    provider: "openai",
    model: logicalModel,
    tokensIn,
    tokensOut,
  });

  await logRequestFinish(logId, {
    status: upstreamResponse.ok ? "success" : "error",
    httpStatus: upstreamResponse.status,
    errorClass: upstreamResponse.ok
      ? null
      : responseJson?.error?.type ?? "upstream_error",
    tokensIn,
    tokensOut,
    estimatedCostUsdc,
    finishedAt,
    latencyMs,
  });

  reply.status(upstreamResponse.status);
  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    reply.header("content-type", contentType);
  }
  reply.send(responseJson ?? { error: { message: "Upstream error" } });
}

async function handleStreaming(params: {
  request: FastifyRequest;
  reply: FastifyReply;
  logId: string;
  logicalModel: AllowedModel;
  payload: Record<string, unknown>;
  startedAt: Date;
}) {
  const { request, reply, logId, logicalModel, payload, startedAt } = params;

  let upstreamResponse: any;
  try {
    upstreamResponse = await fetch(OPENAI_API_BASE, {
      method: "POST",
      headers: openAiHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    const finishedAt = new Date();
    await logRequestFinish(logId, {
      status: "error",
      httpStatus: 500,
      errorClass: "upstream_fetch_failed",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
    });
    request.log.error(err);
    return reply.status(500).send({
      error: {
        message: "Upstream request failed",
        type: "internal_error",
      },
    });
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    let responseJson: any = null;
    try {
      responseJson = await upstreamResponse.json();
    } catch {
      // ignore
    }
    const finishedAt = new Date();
    await logRequestFinish(logId, {
      status: "error",
      httpStatus: upstreamResponse.status,
      errorClass: responseJson?.error?.type ?? "upstream_error",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
    });
    return reply
      .status(upstreamResponse.status)
      .send(responseJson ?? { error: { message: "Upstream error" } });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });

  const reader = upstreamResponse.body.getReader();
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
        reply.raw.write(chunk);
        const usage = parseUsageFromChunk(chunk);
        if (usage) {
          if (usage.prompt_tokens != null) tokensIn = usage.prompt_tokens;
          if (usage.completion_tokens != null)
            tokensOut = usage.completion_tokens;
        }
      }
    }
  } catch (err) {
    request.log.error(err);
    const finishedAt = new Date();
    await logRequestFinish(logId, {
      status: "error",
      httpStatus: 500,
      errorClass: "stream_failed",
      finishedAt,
      latencyMs: finishedAt.getTime() - startedAt.getTime(),
    });
    reply.raw.end();
    return;
  }

  reply.raw.end();

  const finishedAt = new Date();
  const estimatedCostUsdc = await calculateCost({
    provider: "openai",
    model: logicalModel,
    tokensIn,
    tokensOut,
  });

  await logRequestFinish(logId, {
    status: "success",
    httpStatus: 200,
    tokensIn,
    tokensOut,
    estimatedCostUsdc,
    finishedAt,
    latencyMs: finishedAt.getTime() - startedAt.getTime(),
  });
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
      const routeTag = routeTagHeader ?? (tier === "SMART" ? "critical" : "fast");

      const requestedModel = body.model as AllowedModel | undefined;
      const logicalModel =
        requestedModel ?? (tier === "SMART" ? "gpt-5-mini" : "gpt-5-nano");
      if (!ALLOWED_MODELS.includes(logicalModel)) {
        return reply.status(400).send({
          error: {
            message: "Unsupported model. Allowed: gpt-5-nano, gpt-5-mini",
            type: "invalid_request_error",
          },
        });
      }

      const upstreamModel = MODEL_MAP[logicalModel];
      const payload: Record<string, unknown> = {
        ...body,
        model: upstreamModel,
      };

      if (body.stream) {
        payload.stream_options = {
          ...(body as any).stream_options,
          include_usage: true,
        };
      }

      if (!request.authContext) {
        return reply.status(401).send({
          error: {
            message: "Unauthorized",
            type: "invalid_request_error",
          },
        });
      }

      let logEntry;
      try {
        logEntry = await logRequestStart({
          request,
          projectId: request.authContext.projectId,
          apiKeyId: request.authContext.apiKeyId,
          routeTag,
          tier,
          model: logicalModel,
        });
      } catch (err) {
        request.log.error(err);
        return reply.status(500).send({
          error: {
            message: "Failed to start request log",
            type: "internal_error",
          },
        });
      }

      const startedAt = new Date();

      if (!process.env.OPENAI_API_KEY) {
        const finishedAt = new Date();
        await logRequestFinish(logEntry.id, {
          status: "error",
          httpStatus: 500,
          errorClass: "missing_openai_api_key",
          finishedAt,
          latencyMs: finishedAt.getTime() - startedAt.getTime(),
        });
        return reply.status(500).send({
          error: {
            message: "OPENAI_API_KEY is not configured",
            type: "config_error",
          },
        });
      }

      if (payload.stream) {
        return handleStreaming({
          request,
          reply,
          logId: logEntry.id,
          logicalModel,
          payload,
          startedAt,
        });
      }

      return handleNonStreaming({
        request,
        reply,
        logId: logEntry.id,
        logicalModel,
        payload,
        startedAt,
      });
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
