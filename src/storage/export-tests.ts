import path from "node:path";
import type { AppConfig } from "../config.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { openDatabase } from "./database.js";
import {
  choices,
  collections,
  entityMedia,
  media,
  parts,
  questionGroups,
  questions,
  tests,
} from "./schema.js";

function slugify(value: string): string {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "test"
  );
}

function groupBy<T, K>(values: T[], keyOf: (value: T) => K): Map<K, T[]> {
  const output = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = output.get(key) ?? [];
    group.push(value);
    output.set(key, group);
  }
  return output;
}

export interface SplitTestExportResult {
  outputDirectory: string;
  manifestPath: string;
  files: Array<{
    testId: number;
    sourceId: string;
    title: string;
    file: string;
    questions: number;
  }>;
}

export function exportTestsToSeparateJson(
  config: AppConfig,
  outputDirectory = "data/exports/tests",
): SplitTestExportResult {
  const targetDirectory = path.resolve(config.cwd, outputDirectory);
  ensureDirectory(targetDirectory);
  const { db, sqlite } = openDatabase(config);
  try {
    const collectionRows = db.select().from(collections).all();
    const testRows = db
      .select()
      .from(tests)
      .all()
      .sort((a, b) => a.id - b.id);
    const partRows = db.select().from(parts).all();
    const groupRows = db.select().from(questionGroups).all();
    const questionRows = db.select().from(questions).all();
    const choiceRows = db.select().from(choices).all();
    const mediaRows = db.select().from(media).all();
    const entityMediaRows = db.select().from(entityMedia).all();

    const collectionById = new Map(
      collectionRows.map((collection) => [collection.id, collection]),
    );
    const partsByTest = groupBy(partRows, (part) => part.testId);
    const groupsByPart = groupBy(groupRows, (group) => group.partId);
    const questionsByPart = groupBy(
      questionRows,
      (question) => question.partId,
    );
    const choicesByQuestion = groupBy(
      choiceRows,
      (choice) => choice.questionId,
    );
    const mediaById = new Map(mediaRows.map((item) => [item.id, item]));
    const entityMediaByEntity = groupBy(
      entityMediaRows,
      (item) => `${item.entityType}:${item.entityId}`,
    );

    const mediaFor = (entityType: string, entityId: number) =>
      (entityMediaByEntity.get(`${entityType}:${entityId}`) ?? [])
        .map((link) => ({
          purpose: link.purpose,
          ...mediaById.get(link.mediaId),
        }))
        .filter((item) => item.id !== undefined);

    const exportedAt = new Date().toISOString();
    const files: SplitTestExportResult["files"] = [];
    for (const [testIndex, test] of testRows.entries()) {
      const testParts = (partsByTest.get(test.id) ?? []).sort(
        (a, b) => a.position - b.position,
      );
      const nestedParts = testParts.map((part) => {
        const partQuestions = (questionsByPart.get(part.id) ?? []).sort(
          (a, b) => a.questionNumber - b.questionNumber,
        );
        const questionPayload = (question: (typeof questionRows)[number]) => ({
          ...question,
          choices: (choicesByQuestion.get(question.id) ?? []).sort(
            (a, b) => a.position - b.position,
          ),
          media: mediaFor("question", question.id),
        });
        const groupedQuestionIds = new Set<number>();
        const nestedGroups = (groupsByPart.get(part.id) ?? [])
          .sort((a, b) => a.position - b.position)
          .map((group) => {
            const groupQuestions = partQuestions
              .filter((question) => question.groupId === group.id)
              .map((question) => {
                groupedQuestionIds.add(question.id);
                return questionPayload(question);
              });
            return {
              ...group,
              media: mediaFor("question_group", group.id),
              questions: groupQuestions,
            };
          });
        return {
          ...part,
          groups: nestedGroups,
          standaloneQuestions: partQuestions
            .filter((question) => !groupedQuestionIds.has(question.id))
            .map(questionPayload),
        };
      });
      const fileName = `${String(testIndex + 1).padStart(3, "0")}-${slugify(test.title)}.json`;
      const payload = {
        schemaVersion: 2,
        exportedAt,
        sourceSystem: "dautoeic",
        collection: collectionById.get(test.collectionId) ?? null,
        test,
        summary: {
          parts: testParts.length,
          passages: testParts.reduce(
            (total, part) => total + (groupsByPart.get(part.id)?.length ?? 0),
            0,
          ),
          questions: testParts.reduce(
            (total, part) =>
              total + (questionsByPart.get(part.id)?.length ?? 0),
            0,
          ),
        },
        parts: nestedParts,
      };
      writeJsonAtomic(path.join(targetDirectory, fileName), payload, 0o644);
      files.push({
        testId: test.id,
        sourceId: test.sourceId,
        title: test.title,
        file: fileName,
        questions: payload.summary.questions,
      });
    }

    const manifestPath = path.join(targetDirectory, "manifest.json");
    writeJsonAtomic(
      manifestPath,
      {
        schemaVersion: 2,
        exportedAt,
        totalTests: files.length,
        files,
      },
      0o644,
    );
    return { outputDirectory: targetDirectory, manifestPath, files };
  } finally {
    sqlite.close();
  }
}
