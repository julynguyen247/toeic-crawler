import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createWorker, PSM, type Worker } from "tesseract.js";
import type { AppConfig } from "../config.js";
import {
  buildGraphicAltText,
  extractSvgText,
  GRAPHIC_ALT_VERSION,
} from "../shared/graphic-alt.js";
import { graphicAltOverrideFor } from "../shared/graphic-alt-overrides.js";
import { ensureDirectory } from "../shared/files.js";
import { openDatabase } from "./database.js";

const execFileAsync = promisify(execFile);

interface OcrResult {
  text: string;
  confidence: number;
}

function ocrScore(result: OcrResult): number {
  const usefulCharacters = result.text.replace(/\s/g, "").length;
  return result.confidence + Math.min(usefulCharacters, 300) / 30;
}

async function recognizeGraphic(
  worker: Worker,
  originalPath: string,
  preparedPath: string,
): Promise<OcrResult> {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: "1",
    user_defined_dpi: "72",
  });
  const prepared = await worker.recognize(preparedPath);
  const preparedResult = {
    text: prepared.data.text,
    confidence: prepared.data.confidence,
  };
  if (
    preparedResult.confidence >= 65 &&
    preparedResult.text.replace(/\s/g, "").length >= 12
  ) {
    return preparedResult;
  }

  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    preserve_interword_spaces: "1",
    user_defined_dpi: "72",
  });
  const original = await worker.recognize(originalPath);
  const originalResult = {
    text: original.data.text,
    confidence: original.data.confidence,
  };
  return ocrScore(preparedResult) >= ocrScore(originalResult)
    ? preparedResult
    : originalResult;
}

interface GraphicGroupRow {
  id: number;
  sourceId: string | null;
  imageAltText: string | null;
  imageAltSource: string | null;
  imageAltVersion: string | null;
  localPath: string | null;
  mimeType: string | null;
}

interface GraphicQuestionRow {
  groupId: number;
  questionNumber: number;
  promptText: string | null;
}

export interface EnrichQuestionGroupsResult {
  graphicGroups: number;
  skippedCurrent: number;
  ocrProcessed: number;
  svgProcessed: number;
  manualOverrides: number;
  contextFallbacks: number;
  needsReview: number;
}

export async function enrichStoredQuestionGroups(
  config: Pick<AppConfig, "cwd" | "databasePath">,
  onProgress?: (completed: number, total: number) => void,
): Promise<EnrichQuestionGroupsResult> {
  const { sqlite } = openDatabase(config);
  let worker: Worker | null = null;
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "toeic-graphic-ocr-"),
  );
  try {
    const rows = sqlite
      .prepare(
        `SELECT g.id,
                g.source_id AS sourceId,
                g.image_alt_text AS imageAltText,
                g.image_alt_source AS imageAltSource,
                g.image_alt_version AS imageAltVersion,
                (
                  SELECT m.local_path
                  FROM entity_media em
                  JOIN media m ON m.id = em.media_id
                  WHERE em.entity_type = 'question_group'
                    AND em.entity_id = g.id
                    AND em.purpose = 'prompt_image'
                  LIMIT 1
                ) AS localPath,
                (
                  SELECT m.mime_type
                  FROM entity_media em
                  JOIN media m ON m.id = em.media_id
                  WHERE em.entity_type = 'question_group'
                    AND em.entity_id = g.id
                    AND em.purpose = 'prompt_image'
                  LIMIT 1
                ) AS mimeType
         FROM question_groups g
         WHERE g.image_url IS NOT NULL
         ORDER BY g.id`,
      )
      .all() as GraphicGroupRow[];
    const questionRows = sqlite
      .prepare(
        `SELECT group_id AS groupId,
                question_number AS questionNumber,
                prompt_text AS promptText
         FROM questions
         WHERE group_id IS NOT NULL
         ORDER BY question_number`,
      )
      .all() as GraphicQuestionRow[];
    const questionsByGroup = new Map<number, GraphicQuestionRow[]>();
    for (const question of questionRows) {
      const values = questionsByGroup.get(question.groupId) ?? [];
      values.push(question);
      questionsByGroup.set(question.groupId, values);
    }
    const update = sqlite.prepare(
      `UPDATE question_groups
       SET image_alt_text = ?,
           image_alt_source = ?,
           image_alt_needs_review = ?,
           image_alt_version = ?
       WHERE id = ?`,
    );
    const result: EnrichQuestionGroupsResult = {
      graphicGroups: rows.length,
      skippedCurrent: 0,
      ocrProcessed: 0,
      svgProcessed: 0,
      manualOverrides: 0,
      contextFallbacks: 0,
      needsReview: 0,
    };
    let completed = 0;

    for (const row of rows) {
      if (
        row.imageAltVersion === GRAPHIC_ALT_VERSION &&
        row.imageAltText?.trim() &&
        row.imageAltSource !== "context"
      ) {
        result.skippedCurrent += 1;
        completed += 1;
        onProgress?.(completed, rows.length);
        continue;
      }
      const groupQuestions = questionsByGroup.get(row.id) ?? [];
      const commonInput = {
        questionNumbers: groupQuestions.map((item) => item.questionNumber),
        prompts: groupQuestions
          .map((item) => item.promptText?.trim())
          .filter((value): value is string => Boolean(value)),
      };
      let extractedText = "";
      let confidence: number | null = null;
      let source: "ocr" | "svg_text" | "context" | "manual" = "context";
      const absolutePath = row.localPath
        ? path.resolve(config.cwd, row.localPath)
        : null;
      const manualOverride = absolutePath
        ? graphicAltOverrideFor(absolutePath)
        : null;

      try {
        if (manualOverride) {
          extractedText = manualOverride;
          confidence = 100;
          source = "manual";
          result.manualOverrides += 1;
        } else if (absolutePath && fs.existsSync(absolutePath)) {
          if (
            row.mimeType === "image/svg+xml" ||
            path.extname(absolutePath).toLowerCase() === ".svg"
          ) {
            extractedText = extractSvgText(
              fs.readFileSync(absolutePath, "utf8"),
            );
            source = extractedText ? "svg_text" : "context";
            result.svgProcessed += 1;
          } else {
            if (!worker) {
              const cachePath = path.join(config.cwd, ".cache", "tesseract");
              ensureDirectory(cachePath);
              worker = await createWorker("eng", 1, { cachePath });
            }
            const preparedPath = path.join(temporaryDirectory, `${row.id}.png`);
            let ocrInputPath = absolutePath;
            try {
              await execFileAsync("magick", [
                absolutePath,
                "-background",
                "white",
                "-alpha",
                "remove",
                "-alpha",
                "off",
                "-strip",
                "-resize",
                "450x450>",
                "-colorspace",
                "Gray",
                "-contrast-stretch",
                "0.5%x0.5%",
                "-density",
                "72",
                preparedPath,
              ]);
              ocrInputPath = preparedPath;
            } catch {
              // ImageMagick is an optional quality improvement; OCR can use the
              // original media directly when it is unavailable or rejects a file.
            }
            const recognition = await recognizeGraphic(
              worker,
              absolutePath,
              ocrInputPath,
            );
            extractedText = recognition.text;
            confidence = recognition.confidence;
            source = extractedText.trim() ? "ocr" : "context";
            result.ocrProcessed += 1;
          }
        }
      } catch {
        source = "context";
        extractedText = "";
        confidence = null;
      }

      const alt = buildGraphicAltText({
        ...commonInput,
        extractedText,
        confidence,
        source,
      });
      if (alt.source === "context") result.contextFallbacks += 1;
      if (alt.needsReview) result.needsReview += 1;
      update.run(
        alt.text,
        alt.source,
        alt.needsReview ? 1 : 0,
        alt.version,
        row.id,
      );
      completed += 1;
      onProgress?.(completed, rows.length);
    }
    return result;
  } finally {
    if (worker) {
      await worker.terminate();
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    sqlite.close();
  }
}
