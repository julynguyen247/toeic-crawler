import { describe, expect, it } from "vitest";
import { graphicAltOverrideFor } from "../src/shared/graphic-alt-overrides.js";

describe("graphic alt overrides", () => {
  it("looks up reviewed descriptions by stable media hash", () => {
    expect(
      graphicAltOverrideFor(
        "/tmp/85c24862f644774c17534cd093eb6584c99cfecd01771199f9933aa1c6d2bb86.webp",
      ),
    ).toContain("Garden Green 23");
    expect(graphicAltOverrideFor("/tmp/unknown.png")).toBeNull();
  });
});
