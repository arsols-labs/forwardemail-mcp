const textEncoder = new TextEncoder();

export function extractBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer[ \t]+([^ \t].*?)\s*$/i);
  return match?.[1] || undefined;
}

export function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left);
  const rightBytes = textEncoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

export function isBearerTokenAuthorized(
  authorization: string | null | undefined,
  expectedToken: string
): boolean {
  const providedToken = extractBearerToken(authorization);
  return providedToken !== undefined && timingSafeTokenEqual(providedToken, expectedToken);
}

export function requireMcpAuthToken(value: string | null | undefined): string {
  const token = value?.trim();
  if (!token) {
    throw new Error("MCP_AUTH_TOKEN is required and must not be empty when using an HTTP transport.");
  }

  return token;
}
