import { parseLogLevel, type LogLevel } from "./logger.js";

export interface AppConfig {
  AUTH_MODE: AuthMode;
  LOG_LEVEL: LogLevel;
  FE_API_URL?: string;
  FE_API_KEY?: string;
  FE_CALDAV_URL?: string;
  FE_CARDDAV_URL?: string;
  FE_ALIAS_USER?: string;
  FE_ALIAS_PASS?: string;
}

export interface ConfigSource {
  [key: string]: string | undefined;
}

export type AuthMode = "env" | "1password-sdk";

const AUTH_MODE_ENV_KEY = "AUTH_MODE";
const AUTH_MODE_ONEPASSWORD_SDK: AuthMode = "1password-sdk";
const DEFAULT_AUTH_MODE: AuthMode = "env";

const CONFIG_KEYS = [
  "FE_API_URL",
  "FE_API_KEY",
  "FE_CALDAV_URL",
  "FE_CARDDAV_URL",
  "FE_ALIAS_USER",
  "FE_ALIAS_PASS"
] as const;

export type AppConfigKey = (typeof CONFIG_KEYS)[number];

interface OnePasswordItemOverview {
  id: string;
  title: string;
}

interface OnePasswordItemSection {
  id: string;
  title: string;
}

interface OnePasswordItemField {
  id: string;
  title: string;
  sectionId?: string;
}

interface OnePasswordItem {
  id: string;
  sections: OnePasswordItemSection[];
  fields: OnePasswordItemField[];
}

interface OnePasswordSecretsClient {
  secrets: {
    resolve(reference: string): Promise<string>;
  };
  items: {
    list(vaultId: string): Promise<OnePasswordItemOverview[]>;
    get(vaultId: string, itemId: string): Promise<OnePasswordItem>;
  };
}

let onePasswordClientPromise: Promise<OnePasswordSecretsClient> | null = null;
const onePasswordReferenceRewriteCache = new Map<string, Promise<string>>();
const onePasswordSecretResolutionCache = new Map<string, Promise<string>>();

const ONEPASSWORD_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function defaultConfigSource(): ConfigSource {
  if (typeof process !== "undefined" && process.env) {
    return process.env as ConfigSource;
  }

  return {};
}

function readConfigValue(source: ConfigSource, name: string): string | undefined {
  const value = source[name];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSecretReference(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("op://");
}

function splitReferenceSegments(reference: string): string[] {
  const withoutScheme = reference.slice("op://".length);
  return withoutScheme.split("/");
}

function isSdkCompatibleReference(reference: string): boolean {
  if (!reference.startsWith("op://")) {
    return false;
  }

  const segments = splitReferenceSegments(reference);
  if (segments.length < 3 || segments.some((segment) => segment.length === 0)) {
    return false;
  }

  return segments.every((segment) => ONEPASSWORD_SEGMENT_PATTERN.test(segment));
}

function equalsIgnoreCase(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function matchesIdOrTitle(entity: { id: string; title: string }, candidate: string): boolean {
  return entity.id === candidate || equalsIgnoreCase(entity.title, candidate);
}

async function rewriteReferenceToIds(
  client: OnePasswordSecretsClient,
  reference: string
): Promise<string> {
  const cached = onePasswordReferenceRewriteCache.get(reference);
  if (cached) {
    return cached;
  }

  const rewritePromise = (async () => {
    if (isSdkCompatibleReference(reference)) {
      return reference;
    }

    const segments = splitReferenceSegments(reference);
    if (segments.length !== 3 && segments.length !== 4) {
      throw new Error(
        `Unsupported secret reference format: "${reference}". Expected op://vault/item/field or op://vault/item/section/field.`
      );
    }

    const [vaultId, itemSegment, firstFieldSegment, secondFieldSegment] = segments;
    const itemOverviews = await client.items.list(vaultId);
    const itemOverview = itemOverviews.find((item) => matchesIdOrTitle(item, itemSegment));
    if (!itemOverview) {
      throw new Error(`Cannot find item "${itemSegment}" in vault "${vaultId}".`);
    }

    const item = await client.items.get(vaultId, itemOverview.id);

    if (segments.length === 3) {
      const field = item.fields.find((itemField) =>
        matchesIdOrTitle({ id: itemField.id, title: itemField.title }, firstFieldSegment)
      );
      if (!field) {
        throw new Error(
          `Cannot find field "${firstFieldSegment}" in item "${itemSegment}" (vault "${vaultId}").`
        );
      }

      return `op://${vaultId}/${itemOverview.id}/${field.id}`;
    }

    const sectionSegment = firstFieldSegment;
    const fieldSegment = secondFieldSegment;
    const section = item.sections.find((itemSection) =>
      matchesIdOrTitle({ id: itemSection.id, title: itemSection.title }, sectionSegment)
    );
    if (!section) {
      throw new Error(
        `Cannot find section "${sectionSegment}" in item "${itemSegment}" (vault "${vaultId}").`
      );
    }

    const field = item.fields.find(
      (itemField) =>
        itemField.sectionId === section.id &&
        matchesIdOrTitle({ id: itemField.id, title: itemField.title }, fieldSegment)
    );
    if (!field) {
      throw new Error(
        `Cannot find field "${fieldSegment}" in section "${sectionSegment}" of item "${itemSegment}" (vault "${vaultId}").`
      );
    }

    return `op://${vaultId}/${itemOverview.id}/${field.id}`;
  })();

  onePasswordReferenceRewriteCache.set(reference, rewritePromise);
  return rewritePromise;
}

async function resolveSecretReference(
  client: OnePasswordSecretsClient,
  reference: string
): Promise<string> {
  const sdkReference = await rewriteReferenceToIds(client, reference);

  const cached = onePasswordSecretResolutionCache.get(sdkReference);
  if (cached) {
    return cached;
  }

  const resolutionPromise = client.secrets.resolve(sdkReference);
  onePasswordSecretResolutionCache.set(sdkReference, resolutionPromise);
  return resolutionPromise;
}

function resolveAuthMode(source: ConfigSource): AuthMode {
  const configuredMode = readConfigValue(source, AUTH_MODE_ENV_KEY);
  if (!configuredMode) {
    return DEFAULT_AUTH_MODE;
  }

  if (configuredMode === DEFAULT_AUTH_MODE || configuredMode === AUTH_MODE_ONEPASSWORD_SDK) {
    return configuredMode;
  }

  throw new Error(
    `Invalid AUTH_MODE="${configuredMode}". Supported values: "${DEFAULT_AUTH_MODE}", "${AUTH_MODE_ONEPASSWORD_SDK}".`
  );
}

async function getOnePasswordClient(source: ConfigSource): Promise<OnePasswordSecretsClient> {
  if (onePasswordClientPromise) {
    return onePasswordClientPromise;
  }

  const token = readConfigValue(source, "OP_SERVICE_ACCOUNT_TOKEN");
  if (!token) {
    throw new Error(
      "AUTH_MODE=1password-sdk requires OP_SERVICE_ACCOUNT_TOKEN to be set in the environment."
    );
  }

  onePasswordClientPromise = (async () => {
    const { createClient } = await import("@1password/sdk");
    return createClient({
      auth: token,
      integrationName: "forwardemail-mcp",
      integrationVersion: "v0.0.0"
    });
  })();

  return onePasswordClientPromise;
}

async function resolveValue(
  source: ConfigSource,
  key: AppConfigKey,
  rawValue: string | undefined,
  authMode: AuthMode
): Promise<string | undefined> {
  if (!rawValue || authMode !== AUTH_MODE_ONEPASSWORD_SDK) {
    return rawValue;
  }

  if (!isSecretReference(rawValue)) {
    return rawValue;
  }

  const client = await getOnePasswordClient(source);
  try {
    const resolved = await resolveSecretReference(client, rawValue);
    const trimmed = resolved.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ${key} from 1Password reference "${rawValue}": ${message}`);
  }
}

export async function loadConfig(source: ConfigSource = defaultConfigSource()): Promise<AppConfig> {
  const authMode = resolveAuthMode(source);
  const config: AppConfig = {
    AUTH_MODE: authMode,
    LOG_LEVEL: parseLogLevel(readConfigValue(source, "LOG_LEVEL"))
  };

  for (const key of CONFIG_KEYS) {
    config[key] = await resolveValue(source, key, readConfigValue(source, key), authMode);
  }

  return config;
}

export function getRequiredConfigValue(config: AppConfig, key: AppConfigKey): string {
  const value = config[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
}
