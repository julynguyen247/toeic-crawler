import { describe, expect, it } from "vitest";
import {
  buildGraphicAltText,
  extractSvgText,
} from "../src/shared/graphic-alt.js";

describe("graphic alt text", () => {
  it("extracts and decodes visible SVG text", () => {
    expect(
      extractSvgText(
        "<svg><title>Office map</title><text>Front &amp; Main</text><text>Room 2</text></svg>",
      ),
    ).toBe("Office map; Front & Main; Room 2");
  });

  it("builds OCR alt text and flags low-confidence output", () => {
    const alt = buildGraphicAltText({
      questionNumbers: [62, 63, 64],
      prompts: ["Look at the map."],
      extractedText: "Station  Park  Library",
      confidence: 52,
      source: "ocr",
    });

    expect(alt.text).toContain("Bản đồ dùng cho câu 62–64");
    expect(alt.text).toContain("Station Park Library");
    expect(alt.needsReview).toBe(true);
  });

  it("uses question context when no image text can be extracted", () => {
    const alt = buildGraphicAltText({
      questionNumbers: [95, 96, 97],
      prompts: ["What is special about the Market Hall?"],
      source: "context",
    });

    expect(alt.source).toBe("context");
    expect(alt.text).toContain("Market Hall");
    expect(alt.needsReview).toBe(true);
  });

  it("uses reviewed manual descriptions without calling them OCR text", () => {
    const alt = buildGraphicAltText({
      questionNumbers: [68, 69, 70],
      prompts: ["Look at the graphic."],
      extractedText: "Bảng giá gồm bốn sản phẩm.",
      confidence: 100,
      source: "manual",
    });

    expect(alt.text).toBe(
      "Biểu đồ dùng cho câu 68–70. Bảng giá gồm bốn sản phẩm.",
    );
    expect(alt.needsReview).toBe(false);
  });
});
