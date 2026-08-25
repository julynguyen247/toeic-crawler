import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import {
  enrichQuestion,
  isOptionListTranslation,
} from "../shared/question-enrichment.js";
import { openDatabase } from "./database.js";
import { parts, questionGroups, questions } from "./schema.js";

export interface EnrichQuestionsResult {
  questions: number;
  generatedExplanations: number;
  preservedExplanations: number;
  imageAltTexts: number;
  skillTaggedQuestions: number;
}

function hasText(value: string | null): boolean {
  return Boolean(value?.trim());
}

export function enrichStoredQuestions(
  config: Pick<AppConfig, "databasePath">,
): EnrichQuestionsResult {
  const { db, sqlite } = openDatabase(config);
  try {
    const rows = db
      .select({
        id: questions.id,
        partNumber: parts.partNumber,
        sourcePayloadJson: questions.sourcePayloadJson,
        explanationText: questions.explanationText,
        explanationVi: questions.explanationVi,
        explanationEn: questions.explanationEn,
        groupImageAltText: questionGroups.imageAltText,
        groupImageAltSource: questionGroups.imageAltSource,
        groupImageAltNeedsReview: questionGroups.imageAltNeedsReview,
        groupContentText: questionGroups.contentText,
        groupTranscript: questionGroups.transcript,
      })
      .from(questions)
      .innerJoin(parts, eq(parts.id, questions.partId))
      .leftJoin(questionGroups, eq(questionGroups.id, questions.groupId))
      .all();
    const result: EnrichQuestionsResult = {
      questions: rows.length,
      generatedExplanations: 0,
      preservedExplanations: 0,
      imageAltTexts: 0,
      skillTaggedQuestions: 0,
    };

    db.transaction((tx) => {
      for (const row of rows) {
        if (!row.sourcePayloadJson) {
          throw new Error(`Question ${row.id} has no source payload.`);
        }
        const source = JSON.parse(row.sourcePayloadJson) as Record<
          string,
          unknown
        >;
        source.part = row.partNumber;
        const enrichment = enrichQuestion(source, {
          groupImageAltText: row.groupImageAltText,
          groupImageAltSource: row.groupImageAltSource,
          groupImageAltNeedsReview:
            row.groupImageAltNeedsReview === null
              ? undefined
              : row.groupImageAltNeedsReview,
          groupContentText: row.groupContentText,
          groupTranscript: row.groupTranscript,
        });
        const hasExistingExplanation =
          hasText(row.explanationText) ||
          hasText(row.explanationVi) ||
          hasText(row.explanationEn);
        const generatedExplanation =
          enrichment.explanationSource === "derived"
            ? enrichment.generatedExplanationVi
            : null;
        if (generatedExplanation) {
          result.generatedExplanations += 1;
        } else if (hasExistingExplanation) {
          result.preservedExplanations += 1;
        }
        if (enrichment.imageAltText) {
          result.imageAltTexts += 1;
        }
        if (enrichment.skillTags.length) {
          result.skillTaggedQuestions += 1;
        }
        tx.update(questions)
          .set({
            explanationText:
              generatedExplanation ??
              row.explanationText ??
              row.explanationVi ??
              row.explanationEn,
            explanationVi: generatedExplanation ?? row.explanationVi,
            explanationEn: isOptionListTranslation(source)
              ? null
              : row.explanationEn,
            explanationSource: enrichment.explanationSource,
            imageAltText: enrichment.imageAltText,
            imageAltSource: enrichment.imageAltSource,
            imageAltNeedsReview: enrichment.imageAltNeedsReview,
            imageAltVersion: enrichment.imageAltVersion,
            skillTagsJson: JSON.stringify(enrichment.skillTags),
            skillTagVersion: enrichment.skillTagVersion,
            enrichmentVersion: enrichment.enrichmentVersion,
          })
          .where(eq(questions.id, row.id))
          .run();
      }
    });
    return result;
  } finally {
    sqlite.close();
  }
}
