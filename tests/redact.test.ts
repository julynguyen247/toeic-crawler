import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  redact,
  REDACTED,
  sanitizeUrl,
} from "../src/shared/redact.js";

describe("redaction", () => {
  it("redacts nested credentials", () => {
    expect(
      redact({
        headers: { Authorization: "Bearer secret", apikey: "anon", safe: "ok" },
        refresh_token: "refresh-secret",
      }),
    ).toEqual({
      headers: { Authorization: REDACTED, apikey: REDACTED, safe: "ok" },
      refresh_token: REDACTED,
    });
  });

  it("redacts or removes signed query parameters", () => {
    const url =
      "https://example.test/audio.mp3?token=secret&x-amz-signature=abc&lang=en";
    expect(sanitizeUrl(url)).toContain("token=%5BREDACTED%5D");
    expect(canonicalizeUrl(url)).toBe("https://example.test/audio.mp3?lang=en");
  });
});
