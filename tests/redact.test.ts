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

  it("does not reinterpret transcript text as a custom-protocol URL", () => {
    const transcript =
      "M-Au: Where is the parking garage?\nW-Am: Behind the office building.";
    expect(sanitizeUrl(transcript)).toBe(transcript);
    expect(redact({ transcript })).toEqual({ transcript });
  });

  it("redacts sensitive query parameters on relative media paths", () => {
    expect(sanitizeUrl("audio/1.mp3?token=secret&v=2")).toBe(
      "audio/1.mp3?token=%5BREDACTED%5D&v=2",
    );
  });
});
