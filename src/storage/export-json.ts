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
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      sourceSystem: "dautoeic",
      collections: db.select().from(collections).all(),
      tests: db.select().from(tests).all(),
      parts: db.select().from(parts).all(),
      questionGroups: db.select().from(questionGroups).all(),
      questions: db.select().from(questions).all(),
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
