import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  ForwardEmailApiError,
  type ListInboxInput,
  type SearchMessagesInput,
  ForwardEmailEmailService,
  type SendEmailInput
} from "../services/email.js";
import { logStructured, type LogLevel } from "../services/logger.js";

const DEFAULT_EMAIL_METADATA_LIMIT = 20;

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function countResultItems(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const containers = ["messages", "results", "items", "data"] as const;
  for (const key of containers) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) {
      return candidate.length;
    }
  }

  return null;
}

function estimateJsonLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : null;
  } catch {
    return null;
  }
}

function logEmailSearch(level: LogLevel, event: string, payload: Record<string, unknown>): void {
  logStructured("email_search", level, event, payload);
}

function logEmailListInbox(level: LogLevel, event: string, payload: Record<string, unknown>): void {
  logStructured("email_list_inbox", level, event, payload);
}

function toText(value: unknown, pretty = true): string {
  if (typeof value === "string") {
    return value;
  }

  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function toolResult(value: unknown, options?: { pretty?: boolean }) {
  return {
    content: [{ type: "text" as const, text: toText(value, options?.pretty ?? true) }]
  };
}

function toolError(error: unknown) {
  if (error instanceof ForwardEmailApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Forward Email API error (${error.status}): ${error.message}`
        }
      ]
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

function ensureSendBody(input: SendEmailInput): string | null {
  if (input.text || input.html) {
    return null;
  }

  return "email_send requires at least one of `text` or `html`.";
}

function normalizeEmailListInboxInput(input: ListInboxInput): ListInboxInput {
  const requestedLimit = input.limit;
  const effectiveLimit = requestedLimit === undefined
    ? DEFAULT_EMAIL_METADATA_LIMIT
    : Math.min(requestedLimit, DEFAULT_EMAIL_METADATA_LIMIT);

  return {
    ...input,
    limit: effectiveLimit
  };
}

function normalizeEmailSearchInput(input: SearchMessagesInput): SearchMessagesInput {
  const requestedLimit = input.limit;
  const effectiveLimit = requestedLimit === undefined
    ? DEFAULT_EMAIL_METADATA_LIMIT
    : Math.min(requestedLimit, DEFAULT_EMAIL_METADATA_LIMIT);

  return {
    ...input,
    limit: effectiveLimit
  };
}

function summarizeEmailSearchResultItem(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;

  return {
    id: source.id,
    root_id: source.root_id,
    thread_id: source.thread_id,
    folder_path: source.folder_path,
    uid: source.uid,
    header_message_id: source.header_message_id,
    subject: source.subject,
    header_date: source.header_date,
    internal_date: source.internal_date,
    retention_date: source.retention_date,
    size: source.size,
    has_attachment: source.has_attachment,
    is_unread: source.is_unread,
    is_flagged: source.is_flagged,
    is_deleted: source.is_deleted,
    is_draft: source.is_draft,
    is_junk: source.is_junk,
    is_encrypted: source.is_encrypted,
    is_searchable: source.is_searchable,
    is_expired: source.is_expired,
    flags: source.flags,
    labels: source.labels
  };
}

function summarizeEmailSearchData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => summarizeEmailSearchResultItem(item));
  }

  return value;
}

export function registerEmailTools(
  server: McpServer,
  service: ForwardEmailEmailService
): void {
  server.registerTool(
    "email_list_inbox",
    {
      description:
        "List inbox messages using Forward Email REST API. Returns metadata-only results; use email_read_message for full message bodies.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async (input) => {
      const toolName = "email_list_inbox";
      const requestId = createRequestId();
      const startedAt = Date.now();
      logEmailListInbox("info", "handler_entry", {
        requestId,
        toolName,
        timestamp: new Date().toISOString(),
        requestedLimit: input.limit ?? null
      });
      logEmailListInbox("debug", "handler_entry_debug", {
        requestId,
        toolName,
        timestamp: new Date().toISOString(),
        params: input
      });

      try {
        const normalizedInput = normalizeEmailListInboxInput(input);
        const data = await service.listInbox(normalizedInput, {
          requestId,
          operation: "listInbox",
          toolName
        });
        const summarizedData = summarizeEmailSearchData(data);
        logEmailListInbox("info", "handler_success", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          workerTimeMs: Date.now() - startedAt,
          httpStatus: 200,
          requestedLimit: input.limit ?? null,
          effectiveLimit: normalizedInput.limit ?? null,
          resultCount: countResultItems(data),
          jsonLength: estimateJsonLength(data),
          summarizedJsonLength: estimateJsonLength(summarizedData)
        });
        return toolResult(summarizedData, { pretty: false });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logEmailListInbox("error", "handler_error", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          workerTimeMs: Date.now() - startedAt,
          errorName: normalizedError.name,
          errorMessage: normalizedError.message
        });
        logEmailListInbox("debug", "handler_error_debug", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          params: input,
          errorStack: normalizedError.stack
        });
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "email_read_message",
    {
      description: "Read one message by id (optionally as raw RFC822).",
      inputSchema: {
        messageId: z.string().min(1),
        eml: z.boolean().optional()
      }
    },
    async (input) => {
      try {
        const data = await service.readMessage(input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "email_search",
    {
      description:
        "Search messages with protocol-agnostic filters. Returns metadata-only results; use email_read_message for full message bodies.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).optional(),
        folder: z.string().optional(),
        query: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        subject: z.string().optional(),
        since: z.string().optional(),
        before: z.string().optional(),
        seen: z.boolean().optional(),
        flagged: z.boolean().optional(),
        answered: z.boolean().optional(),
        draft: z.boolean().optional(),
        larger: z.number().int().nonnegative().optional(),
        smaller: z.number().int().nonnegative().optional(),
        headerName: z.string().optional(),
        headerValue: z.string().optional(),
        filters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
      }
    },
    async (input) => {
      const toolName = "email_search";
      const requestId = createRequestId();
      const startedAt = Date.now();
      logEmailSearch("info", "handler_entry", {
        requestId,
        toolName,
        timestamp: new Date().toISOString(),
        requestedLimit: input.limit ?? null
      });
      logEmailSearch("debug", "handler_entry_debug", {
        requestId,
        toolName,
        timestamp: new Date().toISOString(),
        params: input
      });

      try {
        const normalizedInput = normalizeEmailSearchInput(input);
        const data = await service.searchMessages(normalizedInput, { requestId, toolName });
        const summarizedData = summarizeEmailSearchData(data);
        logEmailSearch("info", "handler_success", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          workerTimeMs: Date.now() - startedAt,
          httpStatus: 200,
          requestedLimit: input.limit ?? null,
          effectiveLimit: normalizedInput.limit ?? null,
          resultCount: countResultItems(data),
          jsonLength: estimateJsonLength(data),
          summarizedJsonLength: estimateJsonLength(summarizedData)
        });
        return toolResult(summarizedData, { pretty: false });
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logEmailSearch("error", "handler_error", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          workerTimeMs: Date.now() - startedAt,
          errorName: normalizedError.name,
          errorMessage: normalizedError.message
        });
        logEmailSearch("debug", "handler_error_debug", {
          requestId,
          toolName,
          timestamp: new Date().toISOString(),
          params: input,
          errorStack: normalizedError.stack
        });
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "email_list_folders",
    {
      description: "List mailbox folders via Forward Email REST API.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        limit: z.number().int().positive().max(100).optional(),
        subscribed: z.boolean().optional()
      }
    },
    async (input) => {
      try {
        const data = await service.listFolders(input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "email_send",
    {
      description: "Send an email via Forward Email REST API.",
      inputSchema: {
        from: z.string().optional(),
        to: z.union([z.string(), z.array(z.string()).nonempty()]),
        cc: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
        bcc: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
        replyTo: z.union([z.string(), z.array(z.string()).nonempty()]).optional(),
        subject: z.string().min(1),
        text: z.string().optional(),
        html: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        attachments: z
          .array(
            z.object({
              filename: z.string().min(1),
              content: z.string().min(1),
              contentType: z.string().optional(),
              encoding: z.string().optional()
            })
          )
          .optional()
      }
    },
    async (input) => {
      const validationError = ensureSendBody(input);
      if (validationError) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: validationError }]
        };
      }

      try {
        const data = await service.sendEmail(input);
        return toolResult(data);
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
