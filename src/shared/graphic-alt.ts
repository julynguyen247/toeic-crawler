export const GRAPHIC_ALT_VERSION = "toeic-graphic-alt-v4";

export interface GraphicAltInput {
  questionNumbers: number[];
  prompts: string[];
  extractedText?: string | null;
  confidence?: number | null;
  source: "ocr" | "svg_text" | "context" | "manual";
}

export interface GraphicAltResult {
  text: string;
  source: "ocr" | "svg_text" | "context" | "manual";
  needsReview: boolean;
  version: string;
}

function clean(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    );
}

export function extractSvgText(svg: string): string {
  const values = [
    ...svg.matchAll(
      /<(?:text|tspan|title|desc)\b[^>]*>([\s\S]*?)<\/(?:text|tspan|title|desc)>/gi,
    ),
  ]
    .map((match) => decodeXml(match[1]!.replace(/<[^>]+>/g, " ")))
    .map(clean)
    .filter(Boolean);
  return [...new Set(values)].join("; ");
}

function questionRange(numbers: number[]): string {
  const ordered = [...new Set(numbers)].sort((a, b) => a - b);
  if (!ordered.length) return "các câu liên quan";
  if (ordered.length === 1) return `câu ${ordered[0]}`;
  return `câu ${ordered[0]}–${ordered.at(-1)}`;
}

function graphicKind(prompts: string[]): string {
  const text = prompts.join(" ").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/map|bản đồ|location|route/, "Bản đồ"],
    [/schedule|timetable|calendar|lịch/, "Bảng lịch"],
    [/chart|graph|biểu đồ/, "Biểu đồ"],
    [/form|application|đơn |mẫu đơn/, "Biểu mẫu"],
    [/invoice|receipt|bill|hóa đơn/, "Hóa đơn"],
    [/coupon|voucher|phiếu/, "Phiếu thông tin"],
    [/menu|thực đơn/, "Thực đơn"],
    [/directory|floor plan|sơ đồ/, "Sơ đồ"],
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] ?? "Đồ họa";
}

export function buildGraphicAltText(input: GraphicAltInput): GraphicAltResult {
  const range = questionRange(input.questionNumbers);
  const kind = graphicKind(input.prompts);
  const extracted = clean(input.extractedText).slice(0, 1400);
  if (extracted) {
    return {
      text:
        input.source === "manual"
          ? `${kind} dùng cho ${range}. ${extracted}`
          : `${kind} dùng cho ${range}. Văn bản nhận diện trong hình: ${extracted}`,
      source: input.source,
      needsReview: input.source === "ocr" && (input.confidence ?? 0) < 65,
      version: GRAPHIC_ALT_VERSION,
    };
  }
  const promptSummary = clean(input.prompts.join("; ")).slice(0, 600);
  return {
    text: `${kind} dùng cho ${range}${promptSummary ? `. Câu hỏi liên quan: ${promptSummary}` : "."}`,
    source: "context",
    needsReview: true,
    version: GRAPHIC_ALT_VERSION,
  };
}
