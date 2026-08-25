import path from "node:path";
import type { AppConfig } from "../config.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { openDatabase } from "./database.js";
import {
  choices,
  contentRecordMedia,
  contentRecords,
  collections,
  crawlRuns,
  entityMedia,
  media,
  parts,
  questionGroups,
  questions,
  sourceSnapshots,
  tests,
} from "./schema.js";

function withSourcePayload<T extends { sourcePayloadJson?: string | null }>(
  row: T,
): Omit<T, "sourcePayloadJson"> & { sourcePayload: unknown } {
  const { sourcePayloadJson, ...value } = row;
  let sourcePayload: unknown = null;
  if (sourcePayloadJson) {
    try {
      sourcePayload = JSON.parse(sourcePayloadJson);
    } catch {
      sourcePayload = null;
    }
  }
  return { ...value, sourcePayload };
}

function withQuestionEnrichment<
  T extends { sourcePayloadJson?: string | null; skillTagsJson: string },
>(row: T) {
  const { skillTagsJson, ...value } = withSourcePayload(row);
  let skillTags: string[] = [];
  try {
    const parsed = JSON.parse(skillTagsJson) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((tag) => typeof tag === "string")
    ) {
      skillTags = parsed;
    }
  } catch {
    skillTags = [];
  }
  return { ...value, skillTags };
}

export function exportDatabaseToJson(
  config: AppConfig,
  outputPath?: string,
): string {
  const target = outputPath
    ? path.resolve(config.cwd, outputPath)
    : path.join(
        config.cwd,
        "data",
        "exports",
        `toeic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
  ensureDirectory(path.dirname(target));
  const { db, sqlite } = openDatabase(config);
  try {
    const payload = {
      schemaVersion: 5,
      exportedAt: new Date().toISOString(),
      sourceSystem: "dautoeic",
      collections: db.select().from(collections).all(),
      tests: db.select().from(tests).all().map(withSourcePayload),
      parts: db.select().from(parts).all(),
      questionGroups: db
        .select()
        .from(questionGroups)
        .all()
        .map(withSourcePayload),
      questions: db.select().from(questions).all().map(withQuestionEnrichment),
      choices: db.select().from(choices).all(),
      contentRecords: db.select().from(contentRecords).all(),
      contentRecordMedia: db.select().from(contentRecordMedia).all(),
      media: db.select().from(media).all(),
      entityMedia: db.select().from(entityMedia).all(),
      crawlRuns: db.select().from(crawlRuns).all(),
      sourceSnapshots: db.select().from(sourceSnapshots).all(),
    };
    writeJsonAtomic(target, payload, 0o644);
    return target;
  } finally {
    sqlite.close();
  }
}
