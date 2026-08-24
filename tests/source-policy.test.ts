import { describe, expect, it } from "vitest";
import {
  SourcePolicy,
  SourcePolicyError,
} from "../src/crawler/source-policy.js";
import { temporaryConfig } from "./helpers.js";

describe("SourcePolicy", () => {
  it("allows configured reads and read-only RPCs", () => {
    const config = temporaryConfig();
    const policy = new SourcePolicy(config);
    expect(() =>
      policy.assertAllowed("GET", `${config.supabaseUrl}/rest/v1/tests`),
    ).not.toThrow();
    expect(() =>
      policy.assertAllowed(
        "POST",
        `${config.supabaseUrl}/rest/v1/rpc/read_test`,
      ),
    ).not.toThrow();
  });

  it("rejects source mutations without both gates", () => {
    const config = temporaryConfig();
    const policy = new SourcePolicy(config, true);
    expect(() =>
      policy.assertAllowed(
        "POST",
        `${config.supabaseUrl}/rest/v1/rpc/write_progress`,
      ),
    ).toThrow(SourcePolicyError);
  });

  it("rejects requests to another origin", () => {
    const policy = new SourcePolicy(temporaryConfig());
    expect(() =>
      policy.assertAllowed("GET", "https://evil.example/rest/v1/tests"),
    ).toThrow(SourcePolicyError);
  });
});
