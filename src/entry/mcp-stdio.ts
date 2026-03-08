import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { type ConfigSource } from "../services/auth.js";
import { createConfiguredMcpServer, loadMcpConfig } from "./mcp-server.js";

const MCP_TRANSPORT_STDIO = "stdio";

export async function startMcpStdioServer(configSource?: ConfigSource): Promise<void> {
  const transport = (process.env.MCP_TRANSPORT ?? MCP_TRANSPORT_STDIO).trim().toLowerCase();
  if (transport !== MCP_TRANSPORT_STDIO) {
    throw new Error(
      `Unsupported MCP_TRANSPORT="${transport}" for stdio entrypoint. Use "${MCP_TRANSPORT_STDIO}".`
    );
  }

  const config = await loadMcpConfig(configSource);
  const server: McpServer = createConfiguredMcpServer(config);

  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
}
