import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage, type MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";

const textEncoder = new TextEncoder();

function toIsomorphicHeaders(headers: Headers): Record<string, string | string[] | undefined> {
  const result: Record<string, string | string[] | undefined> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}

function toSseEventPayload(eventName: string, data: string): string {
  const dataSection = data
    .split(/\r?\n/u)
    .map((line) => `data: ${line}`)
    .join("\n");

  return `event: ${eventName}\n${dataSection}\n\n`;
}

export class WorkerLegacySseTransport implements Transport {
  readonly sessionId: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;

  private readonly endpointPath: string;
  private started = false;
  private closed = false;
  private streamController?: ReadableStreamDefaultController<Uint8Array>;

  constructor(endpointPath: string, sessionId = globalThis.crypto.randomUUID()) {
    this.endpointPath = endpointPath;
    this.sessionId = sessionId;
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("Transport already started.");
    }

    this.started = true;
  }

  createSseResponse(requestUrl: URL): Response {
    if (!this.started) {
      throw new Error("Transport not started.");
    }

    if (this.streamController) {
      throw new Error("SSE stream already established for this session.");
    }

    const endpointUrl = new URL(this.endpointPath, requestUrl);
    endpointUrl.searchParams.set("sessionId", this.sessionId);
    const endpointWithSession = `${endpointUrl.pathname}${endpointUrl.search}${endpointUrl.hash}`;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.streamController = controller;
        this.enqueueSseEvent("endpoint", endpointWithSession);
      },
      cancel: () => {
        void this.close();
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  }

  async handlePostMessage(request: Request, parsedBody: unknown): Promise<Response> {
    if (this.closed) {
      return new Response("SSE session is closed.", { status: 410 });
    }

    if (!this.streamController) {
      return new Response("SSE connection not established.", { status: 500 });
    }

    if (parsedBody === undefined) {
      return new Response("Invalid message: request body is empty.", { status: 400 });
    }

    const parsedResult = JSONRPCMessageSchema.safeParse(parsedBody);
    if (!parsedResult.success) {
      const parseError = parsedResult.error;
      this.onerror?.(parseError);
      return new Response(`Invalid message: ${parseError.message}`, { status: 400 });
    }

    try {
      this.onmessage?.(parsedResult.data, {
        requestInfo: {
          headers: toIsomorphicHeaders(request.headers),
          url: new URL(request.url)
        }
      });
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(wrappedError);
      return new Response(`Failed to process message: ${wrappedError.message}`, { status: 500 });
    }

    return new Response("Accepted", { status: 202 });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.streamController) {
      throw new Error("Not connected.");
    }

    this.enqueueSseEvent("message", JSON.stringify(message));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    if (this.streamController) {
      try {
        this.streamController.close();
      } catch {
        // Stream can already be closed when the client disconnects.
      }

      this.streamController = undefined;
    }

    this.onclose?.();
  }

  private enqueueSseEvent(eventName: string, data: string): void {
    if (!this.streamController) {
      throw new Error("SSE stream is not initialized.");
    }

    const eventPayload = toSseEventPayload(eventName, data);
    try {
      this.streamController.enqueue(textEncoder.encode(eventPayload));
    } catch (error) {
      const wrappedError = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(wrappedError);
      void this.close();
      throw wrappedError;
    }
  }
}
