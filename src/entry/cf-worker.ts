import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { type AppConfig, type ConfigSource } from "../services/auth.js";
import { logStructured } from "../services/logger.js";
import { createConfiguredMcpServer, loadMcpConfig, MCP_TOOL_COUNT } from "./mcp-server.js";

const MCP_PATH = "/mcp";
const LEGACY_SSE_PATH = "/sse";
const LEGACY_SSE_MESSAGE_PATH = "/message";
const HEALTH_PATH = "/health";
const STREAMABLE_PATH_ALIASES = new Set([MCP_PATH, LEGACY_SSE_PATH]);
const BEARER_PREFIX = "Bearer ";
const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, mcp-session-id"
};
const textEncoder = new TextEncoder();

interface WorkerEnv extends ConfigSource {
  MCP_TRANSPORT?: string;
  MCP_AUTH_TOKEN?: string;
}

let configPromise: Promise<AppConfig> | null = null;

function toConfigSource(env: WorkerEnv): ConfigSource {
  const source: ConfigSource = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      source[key] = value;
    }
  }

  return source;
}

async function getConfig(env: WorkerEnv): Promise<AppConfig> {
  if (!configPromise) {
    configPromise = loadMcpConfig(toConfigSource(env));
  }

  return configPromise;
}

function jsonResponse(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: buildHeaders({ "Content-Type": "application/json" })
  });
}

function jsonRpcError(statusCode: number, message: string): Response {
  return jsonResponse(statusCode, {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  });
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const rawBody = (await request.text()).trim();
  if (!rawBody) {
    return undefined;
  }

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new Error("Invalid JSON payload.");
  }
}

function buildHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return headers;
}

function withCors(response: Response): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: buildHeaders(response.headers)
  });
}

function noContentResponse(statusCode: number): Response {
  return new Response(null, {
    status: statusCode,
    headers: buildHeaders()
  });
}

function extractBearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith(BEARER_PREFIX)) {
    return undefined;
  }

  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token || undefined;
}

function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return diff === 0;
}

function isAuthorizedRequest(request: Request, env: WorkerEnv): boolean {
  const expectedToken = env.MCP_AUTH_TOKEN?.trim();
  const providedToken = extractBearerToken(request);

  if (!expectedToken || !providedToken) {
    return false;
  }

  return timingSafeTokenEqual(providedToken, expectedToken);
}

function isLegacySseRequest(pathname: string): boolean {
  return pathname === LEGACY_SSE_PATH || pathname === LEGACY_SSE_MESSAGE_PATH;
}

function isLegacySseGetRequestWithoutSessionHeader(request: Request, pathname: string, method: string): boolean {
  return pathname === LEGACY_SSE_PATH && method === "GET" && !request.headers.has("mcp-session-id");
}

function legacySseNotSupportedResponse(): Response {
  return jsonRpcError(
    410,
    `Legacy SSE transport is not supported on this Cloudflare deployment. Use ${MCP_PATH} with Streamable HTTP.`
  );
}

function standaloneSseAckResponse(): Response {
  return new Response("event: ping\ndata: {}\n\n", {
    status: 200,
    headers: buildHeaders({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    })
  });
}

async function handleStatelessStreamableRequest(
  request: Request,
  env: WorkerEnv,
  parsedBody?: unknown
): Promise<Response> {
  const config = await getConfig(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  const mcpServer = createConfiguredMcpServer(config);

  transport.onclose = () => {
    void mcpServer.close();
  };

  try {
    await mcpServer.connect(transport);
    if (parsedBody === undefined) {
      return await transport.handleRequest(request);
    }

    return await transport.handleRequest(request, { parsedBody });
  } catch (error) {
    await Promise.allSettled([transport.close(), mcpServer.close()]);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;

    if (method === "OPTIONS") {
      return noContentResponse(204);
    }

    if (method === "GET" && pathname === HEALTH_PATH) {
      return jsonResponse(200, { status: "ok", tools: MCP_TOOL_COUNT });
    }

    if (!isAuthorizedRequest(request, env)) {
      return jsonResponse(401, { error: "Unauthorized" });
    }

    try {
      if (isLegacySseRequest(pathname) && (pathname === LEGACY_SSE_MESSAGE_PATH || isLegacySseGetRequestWithoutSessionHeader(request, pathname, method))) {
        return legacySseNotSupportedResponse();
      }

      if (STREAMABLE_PATH_ALIASES.has(pathname)) {
        if (method === "POST") {
          const parsedBody = await parseJsonBody(request);
          return withCors(await handleStatelessStreamableRequest(request, env, parsedBody));
        }

        if (method === "GET") {
          return standaloneSseAckResponse();
        }

        if (method === "DELETE") {
          return withCors(await handleStatelessStreamableRequest(request, env));
        }

        return jsonRpcError(405, `Method ${method} is not allowed for ${pathname}.`);
      }

      return jsonResponse(404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logStructured("cf_worker", "error", "request_error", {
        timestamp: new Date().toISOString(),
        method,
        pathname,
        errorName: normalizedError.name,
        errorMessage: normalizedError.message
      });
      logStructured("cf_worker", "debug", "request_error_debug", {
        timestamp: new Date().toISOString(),
        method,
        pathname,
        errorStack: normalizedError.stack
      });
      return jsonRpcError(500, `Internal server error: ${message}`);
    }
  }
};
