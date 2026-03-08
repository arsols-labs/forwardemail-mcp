export type LogLevel = "error" | "warn" | "info" | "debug";

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

let currentLogLevel: LogLevel = DEFAULT_LOG_LEVEL;
const SENSITIVE_KEY_PATTERN = /(authorization|cookie|password|secret|token)/i;
const MAX_SANITIZE_DEPTH = 6;

function normalizeLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return DEFAULT_LOG_LEVEL;
  }

  const normalizedValue = value.trim().toLowerCase();
  switch (normalizedValue) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      return normalizedValue;
    default:
      return DEFAULT_LOG_LEVEL;
  }
}

function consoleMethodFor(level: LogLevel): "error" | "warn" | "log" {
  switch (level) {
    case "error":
      return "error";
    case "warn":
      return "warn";
    case "info":
    case "debug":
      return "log";
  }
}

export function parseLogLevel(value: string | undefined): LogLevel {
  return normalizeLogLevel(value);
}

export function configureLogger(level: string | undefined): LogLevel {
  currentLogLevel = parseLogLevel(level);
  return currentLogLevel;
}

export function getConfiguredLogLevel(): LogLevel {
  return currentLogLevel;
}

export function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[currentLogLevel];
}

function sanitizeForLogging(value: unknown, key?: string, depth = 0): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[REDACTED]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (depth >= MAX_SANITIZE_DEPTH) {
    return "[TRUNCATED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLogging(item, undefined, depth + 1));
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      sanitized[entryKey] = sanitizeForLogging(entryValue, entryKey, depth + 1);
    }

    return sanitized;
  }

  return value;
}

export function logStructured(
  scope: string,
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>
): void {
  if (!shouldLog(level)) {
    return;
  }

  const sanitizedPayload = sanitizeForLogging(payload) as Record<string, unknown>;
  console[consoleMethodFor(level)](
    JSON.stringify({
      scope,
      event,
      ...sanitizedPayload
    })
  );
}
