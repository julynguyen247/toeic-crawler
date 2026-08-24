import fs from "node:fs";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { saveRawSnapshot } from "../src/storage/raw-snapshot.js";
import { temporaryConfig } from "./helpers.js";

describe("raw snapshots", () => {
  it("redacts secrets before compression", () => {
    const config = temporaryConfig();
    const result = saveRawSnapshot(config, "run-1", "test", "source-1", {
      Authorization: "Bearer secret",
      access_token: "access-secret",
      url: "https://example.test/file?token=signed-secret&lang=en",
    });
    const content = zlib
      .gunzipSync(fs.readFileSync(result.absolutePath))
      .toString("utf8");
    expect(content).not.toContain("Bearer secret");
    expect(content).not.toContain("access-secret");
    expect(content).not.toContain("signed-secret");
    expect(content).toContain("[REDACTED]");
  });
});
