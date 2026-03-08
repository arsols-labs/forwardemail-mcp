import { startMcpHttpServer } from "./entry/mcp-http.js";
import { startMcpStdioServer } from "./entry/mcp-stdio.js";

const transport = (process.env.MCP_TRANSPORT ?? "stdio").trim().toLowerCase();

const startServer = async (): Promise<void> => {
  if (transport === "stdio") {
    await startMcpStdioServer();
    return;
  }

  if (transport === "http") {
    await startMcpHttpServer();
    return;
  }

  throw new Error(`Unsupported MCP_TRANSPORT="${transport}". Use "stdio" or "http".`);
};

startServer().catch((error: unknown) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error(`Failed to start forwardemail-mcp: ${message}`);
  process.exit(1);
});
