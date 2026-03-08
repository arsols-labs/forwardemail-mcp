import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type AppConfig, loadConfig, type ConfigSource } from "../services/auth.js";
import { ForwardEmailCalendarService } from "../services/calendar.js";
import { ForwardEmailContactsService } from "../services/contacts.js";
import { ForwardEmailEmailService } from "../services/email.js";
import { configureLogger } from "../services/logger.js";
import { registerCalendarTools } from "../tools/calendar-tools.js";
import { registerContactsTools } from "../tools/contacts-tools.js";
import { registerEmailTools } from "../tools/email-tools.js";

export const MCP_SERVER_NAME = "forwardemail-mcp";
export const MCP_SERVER_VERSION = "0.1.0";
export const MCP_TOOL_COUNT = 14;

export async function loadMcpConfig(source?: ConfigSource): Promise<AppConfig> {
  return loadConfig(source);
}

export function createConfiguredMcpServer(config: AppConfig): McpServer {
  configureLogger(config.LOG_LEVEL);

  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION
  });

  registerEmailTools(server, new ForwardEmailEmailService(config));
  registerCalendarTools(server, new ForwardEmailCalendarService(config));
  registerContactsTools(server, new ForwardEmailContactsService(config));

  return server;
}
