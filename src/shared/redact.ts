const sensitiveKeyPattern =
  /^(authorization|apikey|cookie|set-cookie|access_?token|refresh_?token|id_?token|token)$/i;
const sensitiveQueryKeys = new Set([
  "token",
  "access_token",
  "refresh_token",
  "signature",
  "sig",
  "x-amz-signature",
]);

export const REDACTED = "[REDACTED]";

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (
        sensitiveQueryKeys.has(normalized) ||
        normalized.includes("signature") ||
        normalized.includes("token")
      ) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return input;
  }
}

export function canonicalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (
        sensitiveQueryKeys.has(normalized) ||
        normalized.includes("signature") ||
        normalized.includes("token") ||
        normalized.includes("expires")
      ) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return input;
  }
}

export function redact<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeUrl(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry)) as T;
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = sensitiveKeyPattern.test(key) ? REDACTED : redact(entry);
    }
    return output as T;
  }

  return value;
}
