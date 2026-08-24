import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`CURRENT_TIMESTAMP`;

export const crawlRuns = sqliteTable("crawl_runs", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  startedAt: text("started_at").notNull().default(now),
  finishedAt: text("finished_at"),
  testsDiscovered: integer("tests_discovered").notNull().default(0),
  testsSucceeded: integer("tests_succeeded").notNull().default(0),
  testsFailed: integer("tests_failed").notNull().default(0),
  questionsSaved: integer("questions_saved").notNull().default(0),
  mediaSaved: integer("media_saved").notNull().default(0),
  readOnly: integer("read_only", { mode: "boolean" }).notNull().default(true),
  sourceMutationsJson: text("source_mutations_json").notNull().default("[]"),
  errorSummaryJson: text("error_summary_json").notNull().default("[]"),
});

export const collections = sqliteTable(
  "collections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceSystem: text("source_system").notNull().default("dautoeic"),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    sourceUrl: text("source_url"),
    sourceUpdatedAt: text("source_updated_at"),
    firstSeenRunId: text("first_seen_run_id").references(() => crawlRuns.id),
    lastSeenRunId: text("last_seen_run_id").references(() => crawlRuns.id),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    contentHash: text("content_hash"),
    missingFromSource: integer("missing_from_source", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("collections_source_unique").on(
      table.sourceSystem,
      table.sourceId,
    ),
  ],
);

export const tests = sqliteTable(
  "tests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    collectionId: integer("collection_id")
      .notNull()
      .references(() => collections.id),
    sourceId: text("source_id").notNull(),
    title: text("title").notNull(),
    difficulty: text("difficulty"),
    questionCount: integer("question_count"),
    sourceUrl: text("source_url"),
    sourceUpdatedAt: text("source_updated_at"),
    contentHash: text("content_hash"),
    crawlStatus: text("crawl_status").notNull().default("pending"),
    crawledAt: text("crawled_at"),
    firstSeenRunId: text("first_seen_run_id").references(() => crawlRuns.id),
    lastSeenRunId: text("last_seen_run_id").references(() => crawlRuns.id),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    missingFromSource: integer("missing_from_source", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("tests_collection_source_unique").on(
      table.collectionId,
      table.sourceId,
    ),
    index("tests_status_idx").on(table.crawlStatus),
  ],
);

export const parts = sqliteTable(
  "parts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    testId: integer("test_id")
      .notNull()
      .references(() => tests.id),
    partNumber: integer("part_number").notNull(),
    title: text("title"),
    instructions: text("instructions"),
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("parts_test_number_unique").on(table.testId, table.partNumber),
  ],
);

export const questionGroups = sqliteTable(
  "question_groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    partId: integer("part_id")
      .notNull()
      .references(() => parts.id),
    sourceId: text("source_id"),
    contentHtml: text("content_html"),
    contentText: text("content_text"),
    transcript: text("transcript"),
    translation: text("translation"),
    audioUrl: text("audio_url"),
    imageUrl: text("image_url"),
    position: integer("position").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    uniqueIndex("groups_part_source_unique").on(table.partId, table.sourceId),
    uniqueIndex("groups_part_position_hash_unique").on(
      table.partId,
      table.position,
      table.contentHash,
    ),
  ],
);

export const questions = sqliteTable(
  "questions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    testId: integer("test_id")
      .notNull()
      .references(() => tests.id),
    partId: integer("part_id")
      .notNull()
      .references(() => parts.id),
    groupId: integer("group_id").references(() => questionGroups.id),
    sourceId: text("source_id"),
    questionNumber: integer("question_number").notNull(),
    promptHtml: text("prompt_html"),
    promptText: text("prompt_text"),
    correctChoiceKey: text("correct_choice_key"),
    explanationHtml: text("explanation_html"),
    explanationText: text("explanation_text"),
    evidence: text("evidence"),
    audioUrl: text("audio_url"),
    imageUrl: text("image_url"),
    position: integer("position").notNull(),
    contentHash: text("content_hash").notNull(),
  },
  (table) => [
    uniqueIndex("questions_test_source_unique").on(
      table.testId,
      table.sourceId,
    ),
    uniqueIndex("questions_test_number_unique").on(
      table.testId,
      table.questionNumber,
    ),
  ],
);

export const choices = sqliteTable(
  "choices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    questionId: integer("question_id")
      .notNull()
      .references(() => questions.id),
    choiceKey: text("choice_key").notNull(),
    contentHtml: text("content_html"),
    contentText: text("content_text"),
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("choices_question_key_unique").on(
      table.questionId,
      table.choiceKey,
    ),
  ],
);

export const media = sqliteTable(
  "media",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    provider: text("provider").notNull(),
    bucket: text("bucket"),
    objectPath: text("object_path"),
    canonicalUrl: text("canonical_url"),
    localPath: text("local_path"),
    mediaType: text("media_type").notNull(),
    mimeType: text("mime_type"),
    sha256: text("sha256"),
    byteSize: integer("byte_size"),
    downloadStatus: text("download_status").notNull().default("pending"),
    lastDownloadedAt: text("last_downloaded_at"),
  },
  (table) => [
    uniqueIndex("media_storage_locator_unique").on(
      table.provider,
      table.bucket,
      table.objectPath,
    ),
    index("media_sha256_idx").on(table.sha256),
    index("media_download_status_idx").on(table.downloadStatus),
  ],
);

export const entityMedia = sqliteTable(
  "entity_media",
  {
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id),
    entityType: text("entity_type").notNull(),
    entityId: integer("entity_id").notNull(),
    purpose: text("purpose").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.mediaId, table.entityType, table.entityId, table.purpose],
    }),
  ],
);

export const sourceSnapshots = sqliteTable(
  "source_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    crawlRunId: text("crawl_run_id")
      .notNull()
      .references(() => crawlRuns.id),
    entityType: text("entity_type").notNull(),
    entitySourceId: text("entity_source_id").notNull(),
    payloadPath: text("payload_path").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    capturedAt: text("captured_at").notNull().default(now),
    redactionVersion: integer("redaction_version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("snapshots_run_entity_hash_unique").on(
      table.crawlRunId,
      table.entityType,
      table.entitySourceId,
      table.payloadSha256,
    ),
  ],
);

export const contentRecords = sqliteTable(
  "content_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceTable: text("source_table").notNull(),
    sourceId: text("source_id").notNull(),
    parentSourceId: text("parent_source_id"),
    contentType: text("content_type").notNull(),
    title: text("title"),
    payloadJson: text("payload_json").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUpdatedAt: text("source_updated_at"),
    firstSeenRunId: text("first_seen_run_id").references(() => crawlRuns.id),
    lastSeenRunId: text("last_seen_run_id").references(() => crawlRuns.id),
    firstSeenAt: text("first_seen_at").notNull().default(now),
    lastSeenAt: text("last_seen_at").notNull().default(now),
    missingFromSource: integer("missing_from_source", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("content_records_source_unique").on(
      table.sourceTable,
      table.sourceId,
    ),
    index("content_records_type_idx").on(table.contentType),
    index("content_records_parent_idx").on(table.parentSourceId),
  ],
);

export const contentRecordMedia = sqliteTable(
  "content_record_media",
  {
    contentRecordId: integer("content_record_id")
      .notNull()
      .references(() => contentRecords.id),
    mediaId: integer("media_id")
      .notNull()
      .references(() => media.id),
    purpose: text("purpose").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.contentRecordId, table.mediaId, table.purpose],
    }),
  ],
);
