import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { contentHash } from "../shared/checksum.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { canonicalizeUrl } from "../shared/redact.js";
import { openDatabase } from "../storage/database.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";
import {
  choices,
  collections,
  crawlRuns,
  entityMedia,
  media,
  parts,
  questionGroups,
  questions,
  tests,
} from "../storage/schema.js";
import { syncCatalog } from "./catalog.js";
import {
  downloadMedia,
  mergeMediaCandidates,
  type DownloadedMedia,
  type MediaCandidate,
} from "./media.js";
import { SupabaseAdapter } from "./supabase-adapter.js";

const sourceTestSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    total_questions: z.number().nullable().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const sourcePassageSchema = z
  .object({
    id: z.string().uuid(),
    test_id: z.string().uuid(),
    part: z.number().int().min(1).max(7),
    passage_type: z.string().nullable().optional(),
    audio_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    passage_text: z.string().nullable().optional(),
    passage_text_2: z.string().nullable().optional(),
    passage_text_3: z.string().nullable().optional(),
    transcript: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    order_index: z.number().nullable().optional(),
  })
  .passthrough();

const sourceQuestionSchema = z
  .object({
    id: z.string().uuid(),
    test_id: z.string().uuid(),
    passage_id: z.string().uuid().nullable().optional(),
    part: z.number().int().min(1).max(7),
    question_number: z.number().int().positive(),
    order_index: z.number().nullable().optional(),
    audio_url: z.string().nullable().optional(),
    image_url: z.string().nullable().optional(),
    question_text: z.string().nullable().optional(),
    option_a: z.string().nullable().optional(),
    option_b: z.string().nullable().optional(),
    option_c: z.string().nullable().optional(),
    option_d: z.string().nullable().optional(),
    correct_answer: z.enum(["A", "B", "C", "D"]),
    explanation_vi: z.string().nullable().optional(),
    explanation_en: z.string().nullable().optional(),
    dich_nghia: z.string().nullable().optional(),
    dich_nghia_dap_an: z.string().nullable().optional(),
    tu_vung: z.string().nullable().optional(),
    difficulty_level: z.number().nullable().optional(),
    section: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    pilot_status: z.string().nullable().optional(),
  })
  .passthrough();

const sourceMediaMetadataSchema = z.object({
  id: z.string().uuid(),
  media_folder: z.string().nullable().optional(),
  media_version: z.union([z.string(), z.number()]).nullable().optional(),
});

type SourcePassage = z.infer<typeof sourcePassageSchema>;
type SourceQuestion = z.infer<typeof sourceQuestionSchema>;
type SourceMediaMetadata = z.infer<typeof sourceMediaMetadataSchema>;

export interface CrawlTestResult {
  runId: string;
  testId: string;
  title: string;
  questions: number;
  passages: number;
  mediaComplete: number;
  mediaFailed: number;
  mediaSkipped: number;
  reportPath: string;
}

function restPath(table: string, parameters: Record<string, string>): string {
  const query = new URLSearchParams(parameters);
  return `/rest/v1/${table}?${query.toString()}`;
}

function encodeStoragePath(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join("/");
}

export function resolveTestMediaUrl(
  config: Pick<AppConfig, "supabaseUrl">,
  sourceUrl: string,
  metadata: SourceMediaMetadata | null,
): string {
  if (/^https?:\/\//i.test(sourceUrl)) {
    return sourceUrl;
  }
  const folder = metadata?.media_folder;
  if (!folder || folder === "none") {
    throw new Error(
      `Cannot resolve relative media path ${JSON.stringify(sourceUrl)} without a media_folder.`,
    );
  }
  const url = new URL(
    `/storage/v1/object/public/mock-test-media/${encodeStoragePath(folder)}/${encodeStoragePath(sourceUrl)}`,
    config.supabaseUrl,
  );
  if (metadata.media_version !== null && metadata.media_version !== undefined) {
    url.searchParams.set("v", String(metadata.media_version));
  }
  return url.toString();
}

function validateSourceTest(
  test: z.infer<typeof sourceTestSchema>,
  sourceQuestions: SourceQuestion[],
  passages: SourcePassage[],
) {
  const numbers = sourceQuestions.map((question) => question.question_number);
  if (new Set(numbers).size !== numbers.length) {
    throw new Error(`Test ${test.id} contains duplicate question numbers.`);
  }
  if (test.total_questions && sourceQuestions.length !== test.total_questions) {
    throw new Error(
      `Test ${test.id} expected ${test.total_questions} questions, received ${sourceQuestions.length}.`,
    );
  }
  const actualParts = [
    ...new Set(sourceQuestions.map((question) => question.part)),
  ].sort();
  if (
    sourceQuestions.length === 200 &&
    JSON.stringify(actualParts) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7])
  ) {
    throw new Error(`Full test ${test.id} does not contain every Part 1-7.`);
  }
  const passageIds = new Set(passages.map((passage) => passage.id));
  const missingPassages = sourceQuestions
    .map((question) => question.passage_id)
    .filter(
      (passageId): passageId is string =>
        Boolean(passageId) && !passageIds.has(passageId!),
    );
  if (missingPassages.length) {
    throw new Error(
      `Test ${test.id} references ${new Set(missingPassages).size} missing passage(s).`,
    );
  }
  for (const question of sourceQuestions) {
    const value =
      question[
        `option_${question.correct_answer.toLowerCase()}` as keyof SourceQuestion
      ];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(
        `Question ${question.question_number} has no content for correct answer ${question.correct_answer}.`,
      );
    }
  }
}

function collectMedia(
  config: AppConfig,
  sourceQuestions: SourceQuestion[],
  passages: SourcePassage[],
  mediaMetadata: SourceMediaMetadata | null,
): MediaCandidate[] {
  const candidates: MediaCandidate[] = [];
  for (const question of sourceQuestions) {
    if (question.audio_url) {
      candidates.push({
        sourceUrl: resolveTestMediaUrl(
          config,
          question.audio_url,
          mediaMetadata,
        ),
        references: [
          {
            entityType: "question",
            entitySourceId: question.id,
            purpose: "listening_audio",
          },
        ],
      });
    }
    if (question.image_url) {
      candidates.push({
        sourceUrl: resolveTestMediaUrl(
          config,
          question.image_url,
          mediaMetadata,
        ),
        references: [
          {
            entityType: "question",
            entitySourceId: question.id,
            purpose: "prompt_image",
          },
        ],
      });
    }
  }
  for (const passage of passages) {
    if (passage.audio_url) {
      candidates.push({
        sourceUrl: resolveTestMediaUrl(
          config,
          passage.audio_url,
          mediaMetadata,
        ),
        references: [
          {
            entityType: "question_group",
            entitySourceId: passage.id,
            purpose: "listening_audio",
          },
        ],
      });
    }
    if (passage.image_url) {
      candidates.push({
        sourceUrl: resolveTestMediaUrl(
          config,
          passage.image_url,
          mediaMetadata,
        ),
        references: [
          {
            entityType: "question_group",
            entitySourceId: passage.id,
            purpose: "prompt_image",
          },
        ],
      });
    }
  }
  return candidates;
}

function reuseCompletedMedia(
  config: AppConfig,
  handle: ReturnType<typeof startRun>["handle"],
  candidates: MediaCandidate[],
): { reused: DownloadedMedia[]; pending: MediaCandidate[] } {
  const queue = mergeMediaCandidates(config, candidates);
  if (!queue.length) {
    return { reused: [], pending: [] };
  }
  const candidateUrls = queue.map((candidate) =>
    canonicalizeUrl(candidate.sourceUrl),
  );
  const completedByUrl = new Map(
    handle.db
      .select()
      .from(media)
      .where(
        and(
          eq(media.downloadStatus, "complete"),
          inArray(media.canonicalUrl, candidateUrls),
        ),
      )
      .all()
      .filter(
        (item) =>
          item.canonicalUrl &&
          item.localPath &&
          fs.existsSync(path.resolve(config.cwd, item.localPath)),
      )
      .map((item) => [item.canonicalUrl!, item]),
  );
  const reused: DownloadedMedia[] = [];
  const pending: MediaCandidate[] = [];
  for (const candidate of queue) {
    const canonicalUrl = canonicalizeUrl(candidate.sourceUrl);
    const existing = completedByUrl.get(canonicalUrl);
    if (!existing) {
      pending.push(candidate);
      continue;
    }
    reused.push({
      sourceUrl: candidate.sourceUrl,
      provider:
        existing.provider === "supabase-storage"
          ? "supabase-storage"
          : "external",
      bucket: existing.bucket,
      objectPath: existing.objectPath,
      canonicalUrl,
      localPath: existing.localPath,
      mediaType: existing.mediaType === "audio" ? "audio" : "image",
      mimeType: existing.mimeType,
      sha256: existing.sha256,
      byteSize: existing.byteSize,
      downloadStatus: "complete",
      error: null,
      references: candidate.references,
    });
  }
  return { reused, pending };
}

function replaceNormalizedTest(
  config: AppConfig,
  handle: ReturnType<typeof startRun>["handle"],
  runId: string,
  internalTestId: number,
  sourceTest: z.infer<typeof sourceTestSchema>,
  sourceQuestions: SourceQuestion[],
  sourcePassages: SourcePassage[],
  mediaMetadata: SourceMediaMetadata | null,
  downloadedMedia: DownloadedMedia[],
): void {
  handle.db.transaction((tx) => {
    const existingParts = tx
      .select({ id: parts.id })
      .from(parts)
      .where(eq(parts.testId, internalTestId))
      .all();
    const partIds = existingParts.map((row) => row.id);
    const existingQuestions = tx
      .select({ id: questions.id })
      .from(questions)
      .where(eq(questions.testId, internalTestId))
      .all();
    const questionIds = existingQuestions.map((row) => row.id);
    const existingGroups = partIds.length
      ? tx
          .select({ id: questionGroups.id })
          .from(questionGroups)
          .where(inArray(questionGroups.partId, partIds))
          .all()
      : [];
    const groupIds = existingGroups.map((row) => row.id);

    if (questionIds.length) {
      tx.delete(entityMedia)
        .where(
          and(
            eq(entityMedia.entityType, "question"),
            inArray(entityMedia.entityId, questionIds),
          ),
        )
        .run();
      tx.delete(choices).where(inArray(choices.questionId, questionIds)).run();
      tx.delete(questions).where(inArray(questions.id, questionIds)).run();
    }
    if (groupIds.length) {
      tx.delete(entityMedia)
        .where(
          and(
            eq(entityMedia.entityType, "question_group"),
            inArray(entityMedia.entityId, groupIds),
          ),
        )
        .run();
      tx.delete(questionGroups)
        .where(inArray(questionGroups.id, groupIds))
        .run();
    }
    if (partIds.length) {
      tx.delete(parts).where(inArray(parts.id, partIds)).run();
    }

    const partIdByNumber = new Map<number, number>();
    for (const partNumber of [
      ...new Set(sourceQuestions.map((question) => question.part)),
    ].sort()) {
      const row = tx
        .insert(parts)
        .values({
          testId: internalTestId,
          partNumber,
          title: `Part ${partNumber}`,
          position: partNumber,
        })
        .returning({ id: parts.id })
        .get();
      partIdByNumber.set(partNumber, row.id);
    }

    const groupIdBySource = new Map<string, number>();
    for (const passage of [...sourcePassages].sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0),
    )) {
      const partId = partIdByNumber.get(passage.part);
      if (!partId) {
        throw new Error(
          `Passage ${passage.id} references missing Part ${passage.part}.`,
        );
      }
      const contentText = [
        passage.passage_text,
        passage.passage_text_2,
        passage.passage_text_3,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
      const row = tx
        .insert(questionGroups)
        .values({
          partId,
          sourceId: passage.id,
          contentText: contentText || null,
          transcript: passage.transcript ?? null,
          audioUrl: passage.audio_url
            ? canonicalizeUrl(
                resolveTestMediaUrl(config, passage.audio_url, mediaMetadata),
              )
            : null,
          imageUrl: passage.image_url
            ? canonicalizeUrl(
                resolveTestMediaUrl(config, passage.image_url, mediaMetadata),
              )
            : null,
          sourcePayloadJson: JSON.stringify(passage),
          position: passage.order_index ?? 0,
          contentHash: contentHash(passage),
        })
        .returning({ id: questionGroups.id })
        .get();
      groupIdBySource.set(passage.id, row.id);
    }

    const questionIdBySource = new Map<string, number>();
    for (const question of [...sourceQuestions].sort(
      (a, b) => a.question_number - b.question_number,
    )) {
      const partId = partIdByNumber.get(question.part);
      if (!partId) {
        throw new Error(
          `Question ${question.id} references missing Part ${question.part}.`,
        );
      }
      const explanation = [
        question.explanation_vi,
        question.explanation_en,
        question.dich_nghia_dap_an,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n\n");
      const row = tx
        .insert(questions)
        .values({
          testId: internalTestId,
          partId,
          groupId: question.passage_id
            ? (groupIdBySource.get(question.passage_id) ?? null)
            : null,
          sourceId: question.id,
          questionNumber: question.question_number,
          promptText: question.question_text ?? null,
          correctChoiceKey: question.correct_answer,
          explanationText: explanation || null,
          explanationVi: question.explanation_vi ?? null,
          explanationEn: question.explanation_en ?? null,
          translation: question.dich_nghia ?? null,
          answerTranslation: question.dich_nghia_dap_an ?? null,
          vocabulary: question.tu_vung ?? null,
          evidence: question.dich_nghia ?? null,
          difficultyLevel: question.difficulty_level ?? null,
          section: question.section ?? null,
          source: question.source ?? null,
          pilotStatus: question.pilot_status ?? null,
          sourcePayloadJson: JSON.stringify(question),
          audioUrl: question.audio_url
            ? canonicalizeUrl(
                resolveTestMediaUrl(config, question.audio_url, mediaMetadata),
              )
            : null,
          imageUrl: question.image_url
            ? canonicalizeUrl(
                resolveTestMediaUrl(config, question.image_url, mediaMetadata),
              )
            : null,
          position: question.order_index ?? question.question_number,
          contentHash: contentHash(question),
        })
        .returning({ id: questions.id })
        .get();
      questionIdBySource.set(question.id, row.id);

      const sourceChoices = [
        ["A", question.option_a],
        ["B", question.option_b],
        ["C", question.option_c],
        ["D", question.option_d],
      ] as const;
      tx.insert(choices)
        .values(
          sourceChoices
            .filter(
              (choice): choice is readonly ["A" | "B" | "C" | "D", string] =>
                typeof choice[1] === "string",
            )
            .map(([choiceKey, contentText], index) => ({
              questionId: row.id,
              choiceKey,
              contentText,
              position: index + 1,
            })),
        )
        .run();
    }

    for (const downloaded of downloadedMedia) {
      const row = tx
        .insert(media)
        .values({
          provider: downloaded.provider,
          bucket: downloaded.bucket,
          objectPath: downloaded.objectPath,
          canonicalUrl: downloaded.canonicalUrl,
          localPath: downloaded.localPath,
          mediaType: downloaded.mediaType,
          mimeType: downloaded.mimeType,
          sha256: downloaded.sha256,
          byteSize: downloaded.byteSize,
          downloadStatus: downloaded.downloadStatus,
          lastDownloadedAt:
            downloaded.downloadStatus === "complete"
              ? new Date().toISOString()
              : null,
        })
        .onConflictDoUpdate({
          target: [media.provider, media.bucket, media.objectPath],
          set: {
            canonicalUrl: downloaded.canonicalUrl,
            localPath: downloaded.localPath,
            mimeType: downloaded.mimeType,
            sha256: downloaded.sha256,
            byteSize: downloaded.byteSize,
            downloadStatus: downloaded.downloadStatus,
            lastDownloadedAt:
              downloaded.downloadStatus === "complete"
                ? new Date().toISOString()
                : null,
          },
        })
        .returning({ id: media.id })
        .get();
      for (const reference of downloaded.references) {
        const entityId =
          reference.entityType === "question"
            ? questionIdBySource.get(reference.entitySourceId)
            : groupIdBySource.get(reference.entitySourceId);
        if (!entityId) {
          throw new Error(
            `Media references unknown ${reference.entityType} ${reference.entitySourceId}.`,
          );
        }
        tx.insert(entityMedia)
          .values({
            mediaId: row.id,
            entityType: reference.entityType,
            entityId,
            purpose: reference.purpose,
          })
          .onConflictDoNothing()
          .run();
      }
    }

    tx.update(tests)
      .set({
        title: sourceTest.name,
        questionCount: sourceQuestions.length,
        sourceUpdatedAt: sourceTest.updated_at ?? null,
        mediaFolder: mediaMetadata?.media_folder ?? null,
        mediaVersion:
          mediaMetadata?.media_version === null ||
          mediaMetadata?.media_version === undefined
            ? null
            : String(mediaMetadata.media_version),
        sourcePayloadJson: JSON.stringify(sourceTest),
        missingFromSource: false,
        crawlStatus: downloadedMedia.some(
          (item) => item.downloadStatus === "failed",
        )
          ? "partial"
          : "complete",
        crawledAt: new Date().toISOString(),
        contentHash: contentHash({
          sourceTest,
          sourceQuestions,
          sourcePassages,
        }),
        lastSeenRunId: runId,
        lastSeenAt: new Date().toISOString(),
      })
      .where(eq(tests.id, internalTestId))
      .run();
    tx.update(crawlRuns)
      .set({
        testsSucceeded: 1,
        questionsSaved: sourceQuestions.length,
        mediaSaved: downloadedMedia.filter(
          (item) => item.downloadStatus === "complete",
        ).length,
      })
      .where(eq(crawlRuns.id, runId))
      .run();
  });
}

export async function crawlTest(
  config: AppConfig,
  sourceTestId: string,
  options: {
    syncCatalogFirst?: boolean;
    downloadMedia?: boolean;
    syntheticTitle?: string;
  } = {},
): Promise<CrawlTestResult> {
  z.string().uuid().parse(sourceTestId);
  if (options.syncCatalogFirst !== false) {
    await syncCatalog(config);
  }
  const sessions = new SessionProvider(config);
  await sessions.initialize();
  const api = new SupabaseAdapter(config, sessions);
  const { runId, handle } = startRun(config, `test:${sourceTestId}`, true);

  try {
    const [testResponse, questionResponse, passageResponse, mediaResponse] =
      await Promise.all([
        api.get<unknown[]>(
          restPath("mock_tests", { select: "*", id: `eq.${sourceTestId}` }),
        ),
        api.get<unknown[]>(
          restPath("mock_test_questions", {
            select: "*",
            test_id: `eq.${sourceTestId}`,
            order: "question_number.asc",
          }),
        ),
        api.get<unknown[]>(
          restPath("mock_test_passages", {
            select: "*",
            test_id: `eq.${sourceTestId}`,
            order: "order_index.asc",
          }),
        ),
        api.rpc<unknown[]>("get_mock_test_media_batch", {
          p_test_ids: [sourceTestId],
        }),
      ]);
    const sourceTest = sourceTestSchema.parse(
      testResponse.data[0] ?? {
        id: sourceTestId,
        name:
          options.syntheticTitle ??
          `Recovered ETS Test ${sourceTestId.slice(0, 8)}`,
        total_questions: 200,
      },
    );
    const sourceQuestions = z
      .array(sourceQuestionSchema)
      .parse(questionResponse.data);
    const sourcePassages = z
      .array(sourcePassageSchema)
      .parse(passageResponse.data);
    const mediaMetadata =
      z
        .array(sourceMediaMetadataSchema)
        .parse(mediaResponse.data)
        .find((item) => item.id === sourceTestId) ?? null;
    validateSourceTest(sourceTest, sourceQuestions, sourcePassages);

    const referencedPassageIds = new Set(
      sourceQuestions
        .map((question) => question.passage_id)
        .filter((value): value is string => Boolean(value)),
    );
    const referencedPassages = sourcePassages.filter((passage) =>
      referencedPassageIds.has(passage.id),
    );

    const snapshot = saveRawSnapshot(config, runId, "test", sourceTestId, {
      test: sourceTest,
      media: mediaMetadata,
      questions: sourceQuestions,
      passages: sourcePassages,
    });
    recordSnapshot(handle, {
      runId,
      entityType: "test",
      entitySourceId: sourceTestId,
      payloadPath: snapshot.relativePath,
      payloadSha256: snapshot.sha256,
    });

    const mediaCandidates = collectMedia(
      config,
      sourceQuestions,
      referencedPassages,
      mediaMetadata,
    );
    let downloadedMedia: DownloadedMedia[] = [];
    if (options.downloadMedia !== false) {
      const { reused, pending } = reuseCompletedMedia(
        config,
        handle,
        mediaCandidates,
      );
      downloadedMedia = [...reused, ...(await downloadMedia(config, pending))];
    }
    let storedTest = handle.db
      .select({ id: tests.id })
      .from(tests)
      .where(eq(tests.sourceId, sourceTestId))
      .get();
    if (!storedTest) {
      const collection = handle.db
        .insert(collections)
        .values({
          sourceSystem: "dautoeic",
          sourceId: "accessible-question-bank",
          title: "Accessible Question Bank",
          description:
            "Complete tests reconstructed from mock-test questions readable by the authorized account.",
          sourceUrl: `${config.sourceBaseUrl}/mock-test`,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
          contentHash: contentHash({ sourceId: "accessible-question-bank" }),
          missingFromSource: false,
        })
        .onConflictDoUpdate({
          target: [collections.sourceSystem, collections.sourceId],
          set: {
            lastSeenRunId: runId,
            lastSeenAt: new Date().toISOString(),
            missingFromSource: false,
          },
        })
        .returning({ id: collections.id })
        .get();
      storedTest = handle.db
        .insert(tests)
        .values({
          collectionId: collection.id,
          sourceId: sourceTestId,
          title: sourceTest.name,
          questionCount: sourceQuestions.length,
          sourceUrl: `${config.sourceBaseUrl}/mock-test`,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
          contentHash: contentHash(sourceTest),
          mediaFolder: mediaMetadata?.media_folder ?? null,
          mediaVersion:
            mediaMetadata?.media_version === null ||
            mediaMetadata?.media_version === undefined
              ? null
              : String(mediaMetadata.media_version),
          sourcePayloadJson: JSON.stringify(sourceTest),
          missingFromSource: false,
        })
        .returning({ id: tests.id })
        .get();
    }
    replaceNormalizedTest(
      config,
      handle,
      runId,
      storedTest.id,
      sourceTest,
      sourceQuestions,
      referencedPassages,
      mediaMetadata,
      downloadedMedia,
    );

    const mediaComplete = downloadedMedia.filter(
      (item) => item.downloadStatus === "complete",
    ).length;
    const mediaErrors = downloadedMedia
      .filter((item) => item.downloadStatus === "failed")
      .map((item) => ({ url: item.canonicalUrl, error: item.error }));
    const mediaSkipped =
      options.downloadMedia === false ? mediaCandidates.length : 0;
    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    writeJsonAtomic(
      reportPath,
      {
        runId,
        status: mediaErrors.length ? "partial" : "complete",
        mode: "test",
        readOnly: true,
        sourceMutations: [],
        testId: sourceTestId,
        title: sourceTest.name,
        questions: sourceQuestions.length,
        passages: referencedPassages.length,
        sourcePassages: sourcePassages.length,
        ignoredUnreferencedPassages:
          sourcePassages.length - referencedPassages.length,
        mediaComplete,
        mediaFailed: mediaErrors.length,
        mediaSkipped,
        mediaErrors,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );
    finishRun(
      handle,
      runId,
      mediaErrors.length ? "partial" : "complete",
      mediaErrors,
    );
    return {
      runId,
      testId: sourceTestId,
      title: sourceTest.name,
      questions: sourceQuestions.length,
      passages: referencedPassages.length,
      mediaComplete,
      mediaFailed: mediaErrors.length,
      mediaSkipped,
      reportPath,
    };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}

export function completedTestSourceIds(config: AppConfig): Set<string> {
  const { db, sqlite } = openDatabase(config);
  try {
    return new Set(
      db
        .select({ sourceId: tests.sourceId })
        .from(tests)
        .where(eq(tests.crawlStatus, "complete"))
        .all()
        .map((row) => row.sourceId),
    );
  } finally {
    sqlite.close();
  }
}
