import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import worker from "../src/entry/cf-worker.js";
import { extractBearerToken, requireMcpAuthToken } from "../src/entry/http-auth.js";
import { createMcpHttpRequestHandler } from "../src/entry/mcp-http.js";

const env = { MCP_AUTH_TOKEN: "correct-token" };
const config = { AUTH_MODE: "env" as const, LOG_LEVEL: "info" as const };

async function withNodeHttpServer(run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(createMcpHttpRequestHandler(config, env.MCP_AUTH_TOKEN));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("Node HTTP /mcp rejects a missing bearer token", async () => {
  await withNodeHttpServer(async (origin) => {
    assert.equal((await fetch(`${origin}/mcp`)).status, 401);
  });
});

test("Node HTTP /mcp rejects an incorrect bearer token", async () => {
  await withNodeHttpServer(async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      headers: { Authorization: "Bearer wrong-token" }
    });
    assert.equal(response.status, 401);
  });
});

test("Node HTTP /mcp accepts the correct token before session lookup", async () => {
  await withNodeHttpServer(async (origin) => {
    const response = await fetch(`${origin}/mcp`, {
      headers: { Authorization: "Bearer correct-token" }
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /Missing mcp-session-id/);
  });
});

test("Node HTTP /health remains public", async () => {
  await withNodeHttpServer(async (origin) => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "ok");
  });
});

test("/mcp rejects a missing bearer token", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp"), env);
  assert.equal(response.status, 401);
});

test("/mcp rejects an incorrect bearer token", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    headers: { Authorization: "Bearer wrong-token" }
  }), env);
  assert.equal(response.status, 401);
});

test("/mcp accepts the correct bearer token before routing the request", async () => {
  const response = await worker.fetch(new Request("https://example.test/mcp", {
    headers: { Authorization: "Bearer correct-token" }
  }), env);
  assert.equal(response.status, 200);
});

test("/health remains public", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "ok");
});

test("shared bearer parsing and empty-token validation", () => {
  assert.equal(extractBearerToken("bearer token-value"), "token-value");
  assert.equal(extractBearerToken("Basic token-value"), undefined);
  assert.throws(() => requireMcpAuthToken("  "), /MCP_AUTH_TOKEN is required/);
});
