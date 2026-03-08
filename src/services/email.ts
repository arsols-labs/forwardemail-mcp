import { getRequiredConfigValue, type AppConfig } from "./auth.js";
import { logStructured, shouldLog } from "./logger.js";

type QueryValue = string | number | boolean | undefined;

export interface ListInboxInput {
  page?: number;
  limit?: number;
}

export interface ReadMessageInput {
  messageId: string;
  eml?: boolean;
}

export interface SearchMessagesInput {
  page?: number;
  limit?: number;
  folder?: string;
  query?: string;
  from?: string;
  to?: string;
  subject?: string;
  since?: string;
  before?: string;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  draft?: boolean;
  larger?: number;
  smaller?: number;
  headerName?: string;
  headerValue?: string;
  filters?: Record<string, QueryValue>;
}

export interface ListFoldersInput {
  page?: number;
  limit?: number;
  subscribed?: boolean;
}

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
  encoding?: string;
}

export interface SendEmailInput {
  from?: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, QueryValue>;
  body?: unknown;
  accept?: string;
  auth?: "alias" | "apiKey";
  trace?: RequestTraceOptions;
}

interface RequestTraceOptions {
  requestId?: string;
  operation?: string;
  toolName?: string;
}

export class ForwardEmailApiError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;

  constructor(status: number, message: string, responseBody: unknown) {
    super(message);
    this.name = "ForwardEmailApiError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

function appendQueryParam(params: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined) {
    return;
  }

  if (typeof value === "boolean") {
    params.set(key, value ? "true" : "false");
    return;
  }

  params.set(key, String(value));
}

function asText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }

  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function maskSensitiveUrl(url: URL): string {
  const masked = new URL(url.toString());

  if (masked.username) {
    masked.username = "***";
  }

  if (masked.password) {
    masked.password = "***";
  }

  return masked.toString();
}

function parseResponseBody(contentType: string, rawBody: string): unknown {
  if (contentType.includes("application/json")) {
    try {
      return rawBody ? JSON.parse(rawBody) : null;
    } catch {
      return rawBody;
    }
  }

  return rawBody;
}

function collectDiagnosticHeaders(headers: Headers): Record<string, string> {
  const interestingHeaders = [
    "content-length",
    "content-type",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-page-count",
    "x-page-current",
    "x-page-size",
    "x-item-count",
    "cf-ray"
  ];
  const collected: Record<string, string> = {};

  for (const key of interestingHeaders) {
    const value = headers.get(key);
    if (value) {
      collected[key] = value;
    }
  }

  return collected;
}

function logEmailService(
  level: "error" | "info" | "debug",
  event: string,
  payload: Record<string, unknown>
): void {
  logStructured("forward_email_service", level, event, payload);
}

function encodeBase64(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf8").toString("base64");
  }

  throw new Error("No base64 encoder is available in the current runtime.");
}

function toBasicAuthorization(username: string, password: string): string {
  return `Basic ${encodeBase64(`${username}:${password}`)}`;
}

export class ForwardEmailEmailService {
  private readonly baseUrl: string;
  private readonly aliasAuthorization: string;
  private readonly apiKeyAuthorization: string;

  constructor(config: AppConfig) {
    const resolvedBaseUrl = getRequiredConfigValue(config, "FE_API_URL");
    const aliasUser = getRequiredConfigValue(config, "FE_ALIAS_USER");
    const aliasPass = getRequiredConfigValue(config, "FE_ALIAS_PASS");
    const apiKey = getRequiredConfigValue(config, "FE_API_KEY");

    this.baseUrl = resolvedBaseUrl.endsWith("/") ? resolvedBaseUrl : `${resolvedBaseUrl}/`;
    this.aliasAuthorization = toBasicAuthorization(aliasUser, aliasPass);
    this.apiKeyAuthorization = toBasicAuthorization(apiKey, "");
  }

  private authorizationHeaderFor(auth: RequestOptions["auth"]): string {
    return auth === "apiKey" ? this.apiKeyAuthorization : this.aliasAuthorization;
  }

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path.replace(/^\//, ""), this.baseUrl);

    if (options.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options.query)) {
        appendQueryParam(params, key, value);
      }
      url.search = params.toString();
    }

    const headers: Record<string, string> = {
      Authorization: this.authorizationHeaderFor(options.auth),
      Accept: options.accept ?? "application/json"
    };

    const method = options.method ?? "GET";
    const requestInit: RequestInit = { method, headers };
    const requestId = options.trace?.requestId;
    const operation = options.trace?.operation ?? path;
    const toolName = options.trace?.toolName ?? null;
    const maskedUrl = maskSensitiveUrl(url);

    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(options.body);
    }

    logEmailService("debug", "request_start", {
      requestId,
      toolName,
      operation,
      timestamp: new Date().toISOString(),
      method,
      url: maskedUrl,
      query: options.query ?? null,
      accept: headers.Accept,
      authMode: options.auth ?? "alias"
    });

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(url, requestInit);
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      logEmailService("error", "request_fetch_error", {
        requestId,
        toolName,
        operation,
        timestamp: new Date().toISOString(),
        feTimeMs: Date.now() - startedAt,
        errorName: normalizedError.name,
        errorMessage: normalizedError.message
      });
      logEmailService("debug", "request_fetch_error_debug", {
        requestId,
        toolName,
        operation,
        timestamp: new Date().toISOString(),
        method,
        url: maskedUrl,
        errorStack: normalizedError.stack
      });
      throw error;
    }

    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const rawBody = await response.text();
    const responseBody = parseResponseBody(contentType, rawBody);
    const diagnosticHeaders = collectDiagnosticHeaders(response.headers);

    logEmailService(response.ok ? "info" : "error", "response", {
      requestId,
      toolName,
      operation,
      timestamp: new Date().toISOString(),
      feStatus: response.status,
      feTimeMs: durationMs,
      contentLength: response.headers.get("content-length"),
      rawBodyLength: rawBody.length
    });

    if (shouldLog("debug")) {
      logEmailService("debug", "response_debug", {
        requestId,
        toolName,
        operation,
        timestamp: new Date().toISOString(),
        method,
        url: maskedUrl,
        statusText: response.statusText,
        headers: diagnosticHeaders
      });
    }

    if (!response.ok) {
      logEmailService("debug", "response_error_body", {
        requestId,
        toolName,
        operation,
        timestamp: new Date().toISOString(),
        feStatus: response.status,
        statusText: response.statusText,
        url: maskedUrl,
        bodyPreview: rawBody.slice(0, 1000)
      });
      const message = `Forward Email API request failed (${response.status} ${response.statusText}): ${asText(responseBody)}`;
      throw new ForwardEmailApiError(response.status, message, responseBody);
    }

    return responseBody as T;
  }

  public async listInbox(
    input: ListInboxInput = {},
    diagnostics: RequestTraceOptions = {}
  ): Promise<unknown> {
    return this.request("/v1/messages", {
      query: {
        folder: "INBOX",
        page: input.page,
        limit: input.limit
      },
      trace: {
        requestId: diagnostics.requestId,
        operation: diagnostics.operation ?? "listInbox",
        toolName: diagnostics.toolName ?? "email_list_inbox"
      }
    });
  }

  public async readMessage(input: ReadMessageInput): Promise<unknown> {
    return this.request(`/v1/messages/${encodeURIComponent(input.messageId)}`, {
      query: {
        eml: input.eml ? true : undefined
      },
      accept: input.eml ? "message/rfc822, application/json" : "application/json"
    });
  }

  public async searchMessages(
    input: SearchMessagesInput,
    diagnostics: RequestTraceOptions = {}
  ): Promise<unknown> {
    const query: Record<string, QueryValue> = {
      page: input.page,
      limit: input.limit,
      folder: input.folder,
      text: input.query,
      from: input.from,
      to: input.to,
      subject: input.subject,
      since: input.since,
      before: input.before,
      seen: input.seen,
      flagged: input.flagged,
      answered: input.answered,
      draft: input.draft,
      larger: input.larger,
      smaller: input.smaller
    };

    if (input.headerName && input.headerValue) {
      query.header = `${input.headerName}:${input.headerValue}`;
    }

    if (input.filters) {
      for (const [key, value] of Object.entries(input.filters)) {
        query[key] = value;
      }
    }

    logEmailService("debug", "search_messages_request", {
      requestId: diagnostics.requestId,
      toolName: diagnostics.toolName ?? "email_search",
      timestamp: new Date().toISOString(),
      query
    });

    return this.request("/v1/messages", {
      query,
      trace: {
        requestId: diagnostics.requestId,
        operation: diagnostics.operation ?? "searchMessages",
        toolName: diagnostics.toolName ?? "email_search"
      }
    });
  }

  public async listFolders(input: ListFoldersInput = {}): Promise<unknown> {
    return this.request("/v1/folders", {
      query: {
        page: input.page,
        limit: input.limit,
        subscribed: input.subscribed
      }
    });
  }

  public async sendEmail(input: SendEmailInput): Promise<unknown> {
    return this.request("/v1/emails", {
      method: "POST",
      auth: "apiKey",
      body: {
        from: input.from,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        reply_to: input.replyTo,
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers: input.headers,
        attachments: input.attachments
      }
    });
  }
}
