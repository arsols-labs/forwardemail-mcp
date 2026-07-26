const textEncoder = new TextEncoder();

export function extractBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const value = authorization.trim();
  const schemeLength = "Bearer".length;
  if (value.slice(0, schemeLength).toLowerCase() !== "bearer") {
    return undefined;
  }

  let tokenStart = schemeLength;
  if (value[tokenStart] !== " " && value[tokenStart] !== "\t") {
    return undefined;
  }

  while (value[tokenStart] === " " || value[tokenStart] === "\t") {
    tokenStart += 1;
  }

  const token = value.slice(tokenStart);
  return token || undefined;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return new Uint8Array(digest);
}

export async function timingSafeTokenEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)]);

  let difference = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= leftDigest[index] ^ rightDigest[index];
  }

  return difference === 0;
}

export async function isBearerTokenAuthorized(
  authorization: string | null | undefined,
  expectedToken: string
): Promise<boolean> {
  const providedToken = extractBearerToken(authorization);
  return providedToken !== undefined && await timingSafeTokenEqual(providedToken, expectedToken);
}

export function requireMcpAuthToken(value: string | null | undefined): string {
  const token = value?.trim();
  if (!token) {
    throw new Error("MCP_AUTH_TOKEN is required and must not be empty when using an HTTP transport.");
  }

  return token;
}
