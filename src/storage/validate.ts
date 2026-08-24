import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { openDatabase } from "./database.js";

export interface ValidationResult {
  integrity: string;
  foreignKeyViolations: unknown[];
  missingMediaFiles: string[];
  checksumMismatches: string[];
  completeness: {
    incompleteTests: ValidationIssueSummary;
    unreferencedQuestionGroups: ValidationIssueSummary;
    unresolvedMediaUrls: ValidationIssueSummary;
    missingSourcePayloads: ValidationIssueSummary;
    missingMediaLinks: ValidationIssueSummary;
    incompleteLinkedMedia: ValidationIssueSummary;
  };
}

export interface ValidationIssueSummary {
  count: number;
  samples: string[];
}

function summarize(values: string[]): ValidationIssueSummary {
  return { count: values.length, samples: values.slice(0, 20) };
}

export function validateDatabase(config: AppConfig): ValidationResult {
  const { sqlite } = openDatabase(config);
  try {
    const integrityRow = sqlite.prepare("PRAGMA integrity_check").get() as {
      integrity_check: string;
    };
    const foreignKeyViolations = sqlite
      .prepare("PRAGMA foreign_key_check")
      .all();
    const mediaRows = sqlite
      .prepare(
        "SELECT local_path, sha256 FROM media WHERE download_status = 'complete' AND local_path IS NOT NULL",
      )
      .all() as Array<{ local_path: string; sha256: string | null }>;
    const missingMediaFiles: string[] = [];
    const checksumMismatches: string[] = [];
    for (const row of mediaRows) {
      const absolutePath = path.resolve(config.cwd, row.local_path);
      if (!fs.existsSync(absolutePath)) {
        missingMediaFiles.push(row.local_path);
        continue;
      }
      if (row.sha256) {
        const actual = crypto
          .createHash("sha256")
          .update(fs.readFileSync(absolutePath))
          .digest("hex");
        if (actual !== row.sha256) {
          checksumMismatches.push(row.local_path);
        }
      }
    }
    const testRows = sqlite
      .prepare(
        `SELECT t.id, t.title, t.question_count AS expected_questions,
                COUNT(DISTINCT q.id) AS questions,
                COUNT(DISTINCT q.question_number) AS question_numbers,
                MIN(q.question_number) AS min_question,
                MAX(q.question_number) AS max_question,
                COUNT(DISTINCT p.part_number) AS parts
         FROM tests t
         LEFT JOIN questions q ON q.test_id = t.id
         LEFT JOIN parts p ON p.test_id = t.id
         GROUP BY t.id`,
      )
      .all() as Array<{
      id: number;
      title: string;
      expected_questions: number | null;
      questions: number;
      question_numbers: number;
      min_question: number | null;
      max_question: number | null;
      parts: number;
    }>;
    const incompleteTests = testRows
      .filter(
        (row) =>
          row.expected_questions === 200 &&
          (row.questions !== 200 ||
            row.question_numbers !== 200 ||
            row.min_question !== 1 ||
            row.max_question !== 200 ||
            row.parts !== 7),
      )
      .map(
        (row) =>
          `${row.title}: questions=${row.questions}, numbers=${row.question_numbers}, range=${row.min_question}-${row.max_question}, parts=${row.parts}`,
      );
    const unreferencedQuestionGroups = (
      sqlite
        .prepare(
          `SELECT COALESCE(qg.source_id, CAST(qg.id AS TEXT)) AS value
           FROM question_groups qg
           LEFT JOIN questions q ON q.group_id = qg.id
           GROUP BY qg.id
           HAVING COUNT(q.id) = 0`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const unresolvedMediaUrls = (
      sqlite
        .prepare(
          `SELECT value FROM (
             SELECT 'question:' || COALESCE(source_id, id) || ':audio=' || audio_url AS value
             FROM questions WHERE audio_url IS NOT NULL AND audio_url NOT LIKE 'http://%' AND audio_url NOT LIKE 'https://%'
             UNION ALL
             SELECT 'question:' || COALESCE(source_id, id) || ':image=' || image_url
             FROM questions WHERE image_url IS NOT NULL AND image_url NOT LIKE 'http://%' AND image_url NOT LIKE 'https://%'
             UNION ALL
             SELECT 'group:' || COALESCE(source_id, id) || ':audio=' || audio_url
             FROM question_groups WHERE audio_url IS NOT NULL AND audio_url NOT LIKE 'http://%' AND audio_url NOT LIKE 'https://%'
             UNION ALL
             SELECT 'group:' || COALESCE(source_id, id) || ':image=' || image_url
             FROM question_groups WHERE image_url IS NOT NULL AND image_url NOT LIKE 'http://%' AND image_url NOT LIKE 'https://%'
           )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const missingSourcePayloads = (
      sqlite
        .prepare(
          `SELECT value FROM (
             SELECT 'test:' || source_id AS value FROM tests WHERE source_payload_json IS NULL
             UNION ALL
             SELECT 'question:' || COALESCE(source_id, id) FROM questions WHERE source_payload_json IS NULL
             UNION ALL
             SELECT 'group:' || COALESCE(source_id, id) FROM question_groups WHERE source_payload_json IS NULL
           )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const missingMediaLinks = (
      sqlite
        .prepare(
          `SELECT value FROM (
             SELECT 'question:' || COALESCE(q.source_id, q.id) || ':audio' AS value
             FROM questions q WHERE q.audio_url IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM entity_media em WHERE em.entity_type = 'question' AND em.entity_id = q.id AND em.purpose = 'listening_audio'
             )
             UNION ALL
             SELECT 'question:' || COALESCE(q.source_id, q.id) || ':image'
             FROM questions q WHERE q.image_url IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM entity_media em WHERE em.entity_type = 'question' AND em.entity_id = q.id AND em.purpose = 'prompt_image'
             )
             UNION ALL
             SELECT 'group:' || COALESCE(qg.source_id, qg.id) || ':audio'
             FROM question_groups qg WHERE qg.audio_url IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM entity_media em WHERE em.entity_type = 'question_group' AND em.entity_id = qg.id AND em.purpose = 'listening_audio'
             )
             UNION ALL
             SELECT 'group:' || COALESCE(qg.source_id, qg.id) || ':image'
             FROM question_groups qg WHERE qg.image_url IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM entity_media em WHERE em.entity_type = 'question_group' AND em.entity_id = qg.id AND em.purpose = 'prompt_image'
             )
           )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const incompleteLinkedMedia = (
      sqlite
        .prepare(
          `SELECT DISTINCT COALESCE(m.canonical_url, CAST(m.id AS TEXT)) AS value
           FROM media m
           JOIN entity_media em ON em.media_id = m.id
           WHERE m.download_status != 'complete' OR m.local_path IS NULL`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    return {
      integrity: integrityRow.integrity_check,
      foreignKeyViolations,
      missingMediaFiles,
      checksumMismatches,
      completeness: {
        incompleteTests: summarize(incompleteTests),
        unreferencedQuestionGroups: summarize(unreferencedQuestionGroups),
        unresolvedMediaUrls: summarize(unresolvedMediaUrls),
        missingSourcePayloads: summarize(missingSourcePayloads),
        missingMediaLinks: summarize(missingMediaLinks),
        incompleteLinkedMedia: summarize(incompleteLinkedMedia),
      },
    };
  } finally {
    sqlite.close();
  }
}
