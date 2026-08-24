import { describe, expect, it } from "vitest";
import { mergeMediaCandidates } from "../src/crawler/media.js";
import { resolveTestMediaUrl } from "../src/crawler/test.js";
import { temporaryConfig } from "./helpers.js";

describe("mergeMediaCandidates", () => {
  it("deduplicates signed Supabase URLs by bucket and object path", () => {
    const config = temporaryConfig();
    const base = `${config.supabaseUrl}/storage/v1/object/sign/audio/test-1/q1.mp3`;
    const merged = mergeMediaCandidates(config, [
      {
        sourceUrl: `${base}?token=first-secret`,
        references: [
          {
            entityType: "question",
            entitySourceId: "question-1",
            purpose: "listening_audio",
          },
        ],
      },
      {
        sourceUrl: `${base}?token=renewed-secret`,
        references: [
          {
            entityType: "question_group",
            entitySourceId: "group-1",
            purpose: "listening_audio",
          },
        ],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.references).toHaveLength(2);
  });

  it("does not duplicate identical entity references", () => {
    const config = temporaryConfig();
    const candidate = {
      sourceUrl: "https://cdn.example.com/image.png?signature=secret",
      references: [
        {
          entityType: "question" as const,
          entitySourceId: "question-1",
          purpose: "prompt_image" as const,
        },
      ],
    };

    const merged = mergeMediaCandidates(config, [candidate, candidate]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.references).toHaveLength(1);
  });
});

describe("resolveTestMediaUrl", () => {
  it("preserves absolute media URLs", () => {
    const config = temporaryConfig();
    const absolute = "https://cdn.example.com/audio/1.mp3";
    expect(
      resolveTestMediaUrl(config, absolute, {
        id: "00000000-0000-4000-8000-000000000001",
        media_folder: "2024/Test 01",
        media_version: 3,
      }),
    ).toBe(absolute);
  });

  it("resolves and encodes relative paths using source media metadata", () => {
    const config = temporaryConfig();
    expect(
      resolveTestMediaUrl(config, "audio files/1.mp3", {
        id: "00000000-0000-4000-8000-000000000001",
        media_folder: "2024/Test 01",
        media_version: 3,
      }),
    ).toBe(
      `${config.supabaseUrl}/storage/v1/object/public/mock-test-media/2024/Test%2001/audio%20files/1.mp3?v=3`,
    );
  });

  it("rejects a relative path when the source exposes no folder", () => {
    const config = temporaryConfig();
    expect(() => resolveTestMediaUrl(config, "1.mp3", null)).toThrow(
      "without a media_folder",
    );
  });
});
