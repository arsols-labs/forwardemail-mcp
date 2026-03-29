import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { logStructured } from "../services/logger.js";
import { createConfiguredMcpServer, loadMcpConfig, MCP_TOOL_COUNT } from "./mcp-server.js";

const DEFAULT_MCP_PORT = 3100;
const MCP_PATH = "/mcp";
const HEALTH_PATH = "/health";
const INTERNAL_SERVER_ERROR_MESSAGE = "Internal server error.";

interface SessionState {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  error: {
    code: number;
    message: string;
  };
  id: null;
}

const sessions = new Map<string, SessionState>();

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_MCP_PORT;
  }

  const port = Number.parseInt(rawPort.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_PORT="${rawPort}". Provide a valid TCP port in range 1..65535.`);
  }

  return port;
}

function jsonResponse(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, statusCode: number, message: string): void {
  const body: JsonRpcErrorBody = {
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message
    },
    id: null
  };

  jsonResponse(res, statusCode, body);
}

function getPathname(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  return url.pathname;
}

function getSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON payload.");
  }
}

async function closeSession(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) {
    return;
  }

  sessions.delete(sessionId);
  await Promise.allSettled([state.transport.close(), state.server.close()]);
}

async function closeAllSessions(): Promise<void> {
  const activeSessions = Array.from(sessions.keys());
  await Promise.all(activeSessions.map((sessionId) => closeSession(sessionId)));
}

export async function startMcpHttpServer(): Promise<void> {
  const config = await loadMcpConfig();
  const port = parsePort(process.env.MCP_PORT);

  const server: Server = createServer(async (req, res) => {
    const method = req.method?.toUpperCase();
    const pathname = getPathname(req);

    if (method === "GET" && pathname === HEALTH_PATH) {
      jsonResponse(res, 200, { status: "ok", tools: MCP_TOOL_COUNT });
      return;
    }

    if (pathname !== MCP_PATH) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }

    try {
      if (method === "POST") {
        const parsedBody = await parseJsonBody(req);
        const sessionId = getSessionId(req);

        if (sessionId) {
          const existingSession = sessions.get(sessionId);
          if (!existingSession) {
            jsonRpcError(res, 404, "Invalid or expired session ID.");
            return;
          }

          await existingSession.transport.handleRequest(req, res, parsedBody);
          return;
        }

        if (!isInitializeRequest(parsedBody)) {
          jsonRpcError(res, 400, "Initialization request required when session is not established.");
          return;
        }

        let newSession: SessionState | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            if (!newSession) {
              return;
            }

            sessions.set(createdSessionId, newSession);
          },
          onsessionclosed: async (closedSessionId) => {
            await closeSession(closedSessionId);
          }
        });

        const mcpServer = createConfiguredMcpServer(config);
        newSession = {
          server: mcpServer,
          transport
        };

        transport.onclose = () => {
          if (!transport.sessionId) {
            return;
          }

          void closeSession(transport.sessionId);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (method === "GET" || method === "DELETE") {
        const sessionId = getSessionId(req);
        if (!sessionId) {
          jsonRpcError(res, 400, "Missing mcp-session-id header.");
          return;
        }

        const session = sessions.get(sessionId);
        if (!session) {
          jsonRpcError(res, 404, "Invalid or expired session ID.");
          return;
        }

        await session.transport.handleRequest(req, res);
        return;
      }

      jsonRpcError(res, 405, `Method ${method ?? "UNKNOWN"} is not allowed for ${MCP_PATH}.`);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logStructured("mcp_http", "error", "request_error", {
        timestamp: new Date().toISOString(),
        method,
        pathname,
        errorName: normalizedError.name,
        errorMessage: normalizedError.message
      });
      logStructured("mcp_http", "debug", "request_error_debug", {
        timestamp: new Date().toISOString(),
        method,
        pathname,
        errorStack: normalizedError.stack
      });
      jsonRpcError(res, 500, INTERNAL_SERVER_ERROR_MESSAGE);
    }
  });

  let isShuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (isShuttingDown) {
      return;
    }

    isShuttingDown = true;
    console.log(`Received ${signal}. Shutting down MCP HTTP server...`);

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await closeAllSessions();
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`forwardemail-mcp HTTP transport listening on port ${port}`);
}
