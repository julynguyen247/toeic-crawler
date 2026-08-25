import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { REDACTION_VERSION } from "../shared/redact.js";
import {
  ENRICHMENT_VERSION,
  IMAGE_ALT_VERSION,
  QUESTION_SKILL_TAGS,
  SKILL_TAG_VERSION,
} from "../shared/question-enrichment.js";
import { GRAPHIC_ALT_VERSION } from "../shared/graphic-alt.js";
import { openDatabase } from "./database.js";

export interface ValidationResult {
  integrity: string;
  foreignKeyViolations: unknown[];
  missingMediaFiles: string[];
  checksumMismatches: string[];
  untrackedMediaFiles: string[];
  completeness: {
    incompleteTests: ValidationIssueSummary;
    unreferencedQuestionGroups: ValidationIssueSummary;
    unresolvedMediaUrls: ValidationIssueSummary;
    missingSourcePayloads: ValidationIssueSummary;
    missingMediaLinks: ValidationIssueSummary;
    incompleteLinkedMedia: ValidationIssueSummary;
    incorrectMissingFlags: ValidationIssueSummary;
    outdatedLatestTestSnapshots: ValidationIssueSummary;
    duplicateCanonicalMedia: ValidationIssueSummary;
    orphanMediaRows: ValidationIssueSummary;
    missingQuestionExplanations: ValidationIssueSummary;
    nonPedagogicalExplanations: ValidationIssueSummary;
    missingQuestionImageAltText: ValidationIssueSummary;
    missingGroupImageAltText: ValidationIssueSummary;
    questionImageAltNeedsReview: ValidationIssueSummary;
    groupImageAltNeedsReview: ValidationIssueSummary;
    missingSkillTags: ValidationIssueSummary;
    genericGrammarSkillTags: ValidationIssueSummary;
    outdatedQuestionEnrichment: ValidationIssueSummary;
    outdatedImageAltText: ValidationIssueSummary;
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
    const trackedMediaFiles = new Set<string>();
    for (const row of mediaRows) {
      const absolutePath = path.resolve(config.cwd, row.local_path);
      trackedMediaFiles.add(absolutePath);
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
    const untrackedMediaFiles = fs.existsSync(config.mediaDir)
      ? fs
          .readdirSync(config.mediaDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(config.mediaDir, entry.name))
          .filter((filePath) => !trackedMediaFiles.has(filePath))
          .map((filePath) => path.relative(config.cwd, filePath))
      : [];
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
           WHERE (
             EXISTS (SELECT 1 FROM entity_media em WHERE em.media_id = m.id)
             OR EXISTS (SELECT 1 FROM content_record_media crm WHERE crm.media_id = m.id)
           )
             AND (m.download_status != 'complete' OR m.local_path IS NULL)`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const incorrectMissingFlags = (
      sqlite
        .prepare(
          `SELECT t.source_id AS value
           FROM tests t
           JOIN collections c ON c.id = t.collection_id
           WHERE c.source_id = 'accessible-question-bank'
             AND t.missing_from_source = 1`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const outdatedLatestTestSnapshots = (
      sqlite
        .prepare(
          `SELECT t.source_id AS value
           FROM tests t
           LEFT JOIN (
             SELECT ss.entity_source_id, ss.redaction_version
             FROM source_snapshots ss
             JOIN (
               SELECT entity_source_id, MAX(id) AS max_id
               FROM source_snapshots
               WHERE entity_type = 'test'
               GROUP BY entity_source_id
             ) latest ON latest.max_id = ss.id
           ) snapshot ON snapshot.entity_source_id = t.source_id
           WHERE snapshot.redaction_version IS NULL
              OR snapshot.redaction_version != ?`,
        )
        .all(REDACTION_VERSION) as Array<{ value: string }>
    ).map((row) => row.value);
    const duplicateCanonicalMedia = (
      sqlite
        .prepare(
          `SELECT canonical_url AS value
           FROM media
           WHERE canonical_url IS NOT NULL
           GROUP BY canonical_url
           HAVING COUNT(*) > 1`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const orphanMediaRows = (
      sqlite
        .prepare(
          `SELECT COALESCE(canonical_url, CAST(id AS TEXT)) AS value
           FROM media m
           WHERE NOT EXISTS (
             SELECT 1 FROM entity_media em WHERE em.media_id = m.id
           )
             AND NOT EXISTS (
               SELECT 1 FROM content_record_media crm WHERE crm.media_id = m.id
             )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const missingQuestionExplanations = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM questions
           WHERE COALESCE(
             NULLIF(TRIM(explanation_text), ''),
             NULLIF(TRIM(explanation_vi), ''),
             NULLIF(TRIM(explanation_en), '')
           ) IS NULL`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const nonPedagogicalExplanations = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM questions
           WHERE explanation_source = 'source_translation'
              OR (
                answer_translation IS NOT NULL
                AND TRIM(COALESCE(explanation_text, '')) = TRIM(answer_translation)
                AND NULLIF(TRIM(COALESCE(explanation_vi, '')), '') IS NULL
                AND NULLIF(TRIM(COALESCE(explanation_en, '')), '') IS NULL
              )
              OR (
                NULLIF(TRIM(json_extract(source_payload_json, '$.explanation_vi')), '') IS NULL
                AND json_extract(source_payload_json, '$.explanation_en') LIKE '%' || char(10) || 'A.%'
                AND json_extract(source_payload_json, '$.explanation_en') LIKE '%' || char(10) || 'B.%'
                AND json_extract(source_payload_json, '$.explanation_en') LIKE '%' || char(10) || 'C.%'
                AND (
                  explanation_source != 'derived'
                  OR NULLIF(TRIM(explanation_en), '') IS NOT NULL
                  OR TRIM(COALESCE(explanation_text, '')) = TRIM(json_extract(source_payload_json, '$.explanation_en'))
                )
              )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const missingQuestionImageAltText = (
      sqlite
        .prepare(
          `SELECT COALESCE(q.source_id, CAST(q.id AS TEXT)) AS value
           FROM questions q
           WHERE q.image_url IS NOT NULL
             AND NULLIF(TRIM(q.image_alt_text), '') IS NULL`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const missingGroupImageAltText = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM question_groups
           WHERE image_url IS NOT NULL
             AND NULLIF(TRIM(image_alt_text), '') IS NULL`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const questionImageAltNeedsReview = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM questions
           WHERE image_url IS NOT NULL
             AND image_alt_needs_review = 1`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const groupImageAltNeedsReview = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM question_groups
           WHERE image_url IS NOT NULL
             AND image_alt_needs_review = 1`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const allowedQuestionSkillTags = new Set<string>(QUESTION_SKILL_TAGS);
    const missingSkillTags = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value,
                  skill_tags_json AS skillTagsJson
           FROM questions`,
        )
        .all() as Array<{ value: string; skillTagsJson: string }>
    )
      .filter((row) => {
        try {
          const parsed = JSON.parse(row.skillTagsJson) as unknown;
          return (
            !Array.isArray(parsed) ||
            parsed.length === 0 ||
            parsed.some(
              (tag) =>
                typeof tag !== "string" || !allowedQuestionSkillTags.has(tag),
            ) ||
            new Set(parsed).size !== parsed.length
          );
        } catch {
          return true;
        }
      })
      .map((row) => row.value);
    const genericGrammarSkillTags = (
      sqlite
        .prepare(
          `SELECT COALESCE(q.source_id, CAST(q.id AS TEXT)) AS value
           FROM questions q
           JOIN parts p ON p.id = q.part_id
           WHERE p.part_number IN (5, 6)
             AND NOT EXISTS (
               SELECT 1
               FROM json_each(q.skill_tags_json) tag
               WHERE tag.value NOT IN (
                 'sentence_completion', 'text_completion',
                 'grammar'
               )
             )`,
        )
        .all() as Array<{ value: string }>
    ).map((row) => row.value);
    const outdatedQuestionEnrichment = (
      sqlite
        .prepare(
          `SELECT COALESCE(source_id, CAST(id AS TEXT)) AS value
           FROM questions
           WHERE enrichment_version IS NULL
              OR enrichment_version != ?
              OR skill_tag_version IS NULL
              OR skill_tag_version != ?`,
        )
        .all(ENRICHMENT_VERSION, SKILL_TAG_VERSION) as Array<{ value: string }>
    ).map((row) => row.value);
    const outdatedImageAltText = (
      sqlite
        .prepare(
          `SELECT value FROM (
             SELECT 'question:' || COALESCE(source_id, id) AS value
             FROM questions
             WHERE image_url IS NOT NULL
               AND (image_alt_version IS NULL OR image_alt_version != ?)
             UNION ALL
             SELECT 'group:' || COALESCE(source_id, id)
             FROM question_groups
             WHERE image_url IS NOT NULL
               AND (image_alt_version IS NULL OR image_alt_version != ?)
           )`,
        )
        .all(IMAGE_ALT_VERSION, GRAPHIC_ALT_VERSION) as Array<{ value: string }>
    ).map((row) => row.value);
    return {
      integrity: integrityRow.integrity_check,
      foreignKeyViolations,
      missingMediaFiles,
      checksumMismatches,
      untrackedMediaFiles,
      completeness: {
        incompleteTests: summarize(incompleteTests),
        unreferencedQuestionGroups: summarize(unreferencedQuestionGroups),
        unresolvedMediaUrls: summarize(unresolvedMediaUrls),
        missingSourcePayloads: summarize(missingSourcePayloads),
        missingMediaLinks: summarize(missingMediaLinks),
        incompleteLinkedMedia: summarize(incompleteLinkedMedia),
        incorrectMissingFlags: summarize(incorrectMissingFlags),
        outdatedLatestTestSnapshots: summarize(outdatedLatestTestSnapshots),
        duplicateCanonicalMedia: summarize(duplicateCanonicalMedia),
        orphanMediaRows: summarize(orphanMediaRows),
        missingQuestionExplanations: summarize(missingQuestionExplanations),
        nonPedagogicalExplanations: summarize(nonPedagogicalExplanations),
        missingQuestionImageAltText: summarize(missingQuestionImageAltText),
        missingGroupImageAltText: summarize(missingGroupImageAltText),
        questionImageAltNeedsReview: summarize(questionImageAltNeedsReview),
        groupImageAltNeedsReview: summarize(groupImageAltNeedsReview),
        missingSkillTags: summarize(missingSkillTags),
        genericGrammarSkillTags: summarize(genericGrammarSkillTags),
        outdatedQuestionEnrichment: summarize(outdatedQuestionEnrichment),
        outdatedImageAltText: summarize(outdatedImageAltText),
      },
    };
  } finally {
    sqlite.close();
  }
}
