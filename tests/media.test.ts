import { describe, expect, it } from "vitest";
import { mergeMediaCandidates } from "../src/crawler/media.js";
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
