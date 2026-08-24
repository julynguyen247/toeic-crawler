import path from "node:path";
import { eq } from "drizzle-orm";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { contentHash } from "../shared/checksum.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";
import { contentRecords } from "../storage/schema.js";
import { SupabaseAdapter } from "./supabase-adapter.js";

const PAGE_SIZE = 1000;
const ID_CHUNK_SIZE = 50;

type SourceRow = Record<string, unknown> & { id: string };

interface TableSpec {
  table: string;
  contentType: string;
  filters?: Record<string, string>;
}

const TABLE_SPECS: TableSpec[] = [
  {
    table: "grammar_topics",
    contentType: "grammar_topic",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "grammar_subtopics",
    contentType: "grammar_subtopic",
    filters: { is_hidden: "eq.false" },
  },
  { table: "lessons", contentType: "grammar_lesson" },
  { table: "questions", contentType: "grammar_question" },
  {
    table: "listening_sets",
    contentType: "listening_set",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "listening_items",
    contentType: "listening_item",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "listening_collection_order",
    contentType: "listening_collection",
  },
  {
    table: "listening_chapter_order",
    contentType: "listening_chapter",
  },
  {
    table: "topic_listening_sets",
    contentType: "topic_listening_set",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "pronunciation_lessons",
    contentType: "pronunciation_lesson",
  },
  {
    table: "reading_passages",
    contentType: "reading_passage",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "video_chapters",
    contentType: "video_chapter",
    filters: { is_hidden: "eq.false" },
  },
  {
    table: "video_lessons",
    contentType: "video_lesson",
    filters: { is_hidden: "eq.false" },
  },
  { table: "lesson_quiz_questions", contentType: "video_quiz_question" },
  { table: "lesson_schedule", contentType: "lesson_schedule" },
  {
    table: "blog_articles",
    contentType: "blog_article",
    filters: { is_hidden: "eq.false" },
  },
];

export interface ContentCrawlResult {
  runId: string;
  counts: Record<string, number>;
  totalRecords: number;
  reportPath: string;
}

function isSourceRow(value: unknown): value is SourceRow {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).id === "string",
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function postgrestIn(values: string[]): string {
  return `in.(${values.join(",")})`;
}

async function fetchPages(
  api: SupabaseAdapter,
  table: string,
  filters: Record<string, string> = {},
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      select: "*",
      order: "id.asc",
      offset: String(offset),
      limit: String(PAGE_SIZE),
      ...filters,
    });
    const response = await api.get<unknown[]>(
      `/rest/v1/${table}?${query.toString()}`,
    );
    const page = response.data.filter(isSourceRow);
    if (page.length !== response.data.length) {
      throw new Error(`${table} returned a row without a string id.`);
    }
    rows.push(...page);
    if (response.data.length < PAGE_SIZE) {
      return rows;
    }
  }
}

async function fetchByIds(
  api: SupabaseAdapter,
  table: string,
  idColumn: string,
  ids: string[],
  filters: Record<string, string> = {},
): Promise<SourceRow[]> {
  const output: SourceRow[] = [];
  for (const idChunk of chunks(ids, ID_CHUNK_SIZE)) {
    output.push(
      ...(await fetchPages(api, table, {
        ...filters,
        [idColumn]: postgrestIn(idChunk),
      })),
    );
  }
  return output;
}

async function fetchVocabularyWords(
  api: SupabaseAdapter,
  partIds: string[],
): Promise<SourceRow[]> {
  const output = new Map<string, SourceRow>();
  for (const partChunk of chunks(partIds, ID_CHUNK_SIZE)) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const query = new URLSearchParams({
        offset: String(offset),
        limit: String(PAGE_SIZE),
      });
      const response = await api.request<unknown[]>(
        `/rest/v1/rpc/get_vocab_words_by_parts?${query.toString()}`,
        {
          method: "POST",
          body: JSON.stringify({ p_part_ids: partChunk }),
        },
      );
      const page = response.data.filter(isSourceRow);
      if (page.length !== response.data.length) {
        throw new Error(
          "get_vocab_words_by_parts returned a row without a string id.",
        );
      }
      for (const row of page) {
        output.set(row.id, row);
      }
      if (response.data.length < PAGE_SIZE) {
        break;
      }
    }
  }
  return [...output.values()];
}

function firstString(
  row: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const value = row[field];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return null;
}

function saveRows(
  config: AppConfig,
  handle: ReturnType<typeof startRun>["handle"],
  runId: string,
  sourceTable: string,
  contentType: string,
  rows: SourceRow[],
): void {
  const snapshot = saveRawSnapshot(config, runId, sourceTable, "all", rows);
  recordSnapshot(handle, {
    runId,
    entityType: sourceTable,
    entitySourceId: "all",
    payloadPath: snapshot.relativePath,
    payloadSha256: snapshot.sha256,
  });
  const now = new Date().toISOString();
  handle.db.transaction((tx) => {
    tx.update(contentRecords)
      .set({ missingFromSource: true })
      .where(eq(contentRecords.sourceTable, sourceTable))
      .run();
    for (const row of rows) {
      const parentSourceId = firstString(row, [
        "part_id",
        "lesson_id",
        "subtopic_id",
        "topic_id",
        "set_id",
        "test_id",
        "chapter_id",
      ]);
      const title = firstString(row, [
        "name",
        "title",
        "title_vi",
        "title_en",
        "question_text",
        "word",
        "sentence_en",
        "collection_name",
        "chapter_name",
      ]);
      tx.insert(contentRecords)
        .values({
          sourceTable,
          sourceId: row.id,
          parentSourceId,
          contentType,
          title,
          payloadJson: JSON.stringify(row),
          contentHash: contentHash(row),
          sourceUpdatedAt:
            typeof row.updated_at === "string" ? row.updated_at : null,
          firstSeenRunId: runId,
          lastSeenRunId: runId,
          lastSeenAt: now,
          missingFromSource: false,
        })
        .onConflictDoUpdate({
          target: [contentRecords.sourceTable, contentRecords.sourceId],
          set: {
            parentSourceId,
            contentType,
            title,
            payloadJson: JSON.stringify(row),
            contentHash: contentHash(row),
            sourceUpdatedAt:
              typeof row.updated_at === "string" ? row.updated_at : null,
            lastSeenRunId: runId,
            lastSeenAt: now,
            missingFromSource: false,
          },
        })
        .run();
    }
  });
}

export async function crawlContent(
  config: AppConfig,
): Promise<ContentCrawlResult> {
  const sessions = new SessionProvider(config);
  await sessions.initialize();
  const api = new SupabaseAdapter(config, sessions);
  const { runId, handle } = startRun(config, "content-all", true);
  const datasets = new Map<
    string,
    { contentType: string; rows: SourceRow[] }
  >();

  try {
    for (const spec of TABLE_SPECS) {
      datasets.set(spec.table, {
        contentType: spec.contentType,
        rows: await fetchPages(api, spec.table, spec.filters),
      });
    }

    const topicSetIds = (datasets.get("topic_listening_sets")?.rows ?? []).map(
      (row) => row.id,
    );
    datasets.set("topic_listening_items", {
      contentType: "topic_listening_item",
      rows: await fetchByIds(
        api,
        "topic_listening_items",
        "set_id",
        topicSetIds,
      ),
    });

    const catalogResponse = await api.rpc<Record<string, unknown>>(
      "get_vocabulary_catalog",
    );
    const catalogSets = Array.isArray(catalogResponse.data.sets)
      ? catalogResponse.data.sets.filter(isSourceRow)
      : [];
    const catalogTests = Array.isArray(catalogResponse.data.tests)
      ? catalogResponse.data.tests
          .filter(
            (value): value is Record<string, unknown> & { test_id: string } =>
              Boolean(
                value &&
                typeof value === "object" &&
                typeof (value as Record<string, unknown>).test_id === "string",
              ),
          )
          .map((row) => ({ ...row, id: row.test_id }))
      : [];
    const vocabularySets = await fetchByIds(
      api,
      "vocabulary_sets",
      "id",
      catalogSets.map((row) => row.id),
    );
    const vocabularyTests = await fetchByIds(
      api,
      "vocabulary_tests",
      "id",
      catalogTests.map((row) => row.id),
    );
    const vocabularyParts = await fetchByIds(
      api,
      "vocabulary_parts",
      "test_id",
      vocabularyTests.map((row) => row.id),
      { is_hidden: "eq.false" },
    );
    const vocabularyWords = await fetchVocabularyWords(
      api,
      vocabularyParts.map((row) => row.id),
    );
    datasets.set("vocabulary_sets", {
      contentType: "vocabulary_set",
      rows: vocabularySets,
    });
    datasets.set("vocabulary_tests", {
      contentType: "vocabulary_test",
      rows: vocabularyTests,
    });
    datasets.set("vocabulary_parts", {
      contentType: "vocabulary_part",
      rows: vocabularyParts,
    });
    datasets.set("vocabulary_words", {
      contentType: "vocabulary_word",
      rows: vocabularyWords,
    });

    const counts: Record<string, number> = {};
    for (const [sourceTable, dataset] of datasets) {
      saveRows(
        config,
        handle,
        runId,
        sourceTable,
        dataset.contentType,
        dataset.rows,
      );
      counts[sourceTable] = dataset.rows.length;
    }
    const totalRecords = Object.values(counts).reduce(
      (total, count) => total + count,
      0,
    );
    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    writeJsonAtomic(
      reportPath,
      {
        runId,
        status: "complete",
        mode: "content-all",
        readOnly: true,
        sourceMutations: [],
        counts,
        totalRecords,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    return { runId, counts, totalRecords, reportPath };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}
