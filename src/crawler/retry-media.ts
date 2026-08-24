import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { openDatabase } from "../storage/database.js";
import { media } from "../storage/schema.js";
import { downloadMedia, type MediaCandidate } from "./media.js";

export interface RetryMediaResult {
  attempted: number;
  completed: number;
  failed: number;
}

export async function retryFailedMedia(
  config: AppConfig,
): Promise<RetryMediaResult> {
  const { db, sqlite } = openDatabase(config);
  try {
    const failedRows = db
      .select({
        id: media.id,
        canonicalUrl: media.canonicalUrl,
        mediaType: media.mediaType,
      })
      .from(media)
      .where(eq(media.downloadStatus, "failed"))
      .all()
      .filter((row): row is typeof row & { canonicalUrl: string } =>
        Boolean(row.canonicalUrl),
      );

    const candidates: MediaCandidate[] = failedRows.map((row) => ({
      sourceUrl: row.canonicalUrl,
      references: [
        {
          entityType: "question",
          entitySourceId: `retry-${row.id}`,
          purpose:
            row.mediaType === "audio" ? "listening_audio" : "prompt_image",
        },
      ],
    }));
    const downloaded = await downloadMedia(config, candidates);

    const rowIdByUrl = new Map(
      failedRows.map((row) => [row.canonicalUrl, row.id]),
    );
    let completed = 0;
    for (const result of downloaded) {
      const rowId = rowIdByUrl.get(result.canonicalUrl);
      if (rowId === undefined) {
        continue;
      }
      if (result.downloadStatus === "complete") {
        completed += 1;
      }
      db.update(media)
        .set({
          localPath: result.localPath,
          mimeType: result.mimeType,
          sha256: result.sha256,
          byteSize: result.byteSize,
          downloadStatus: result.downloadStatus,
          lastDownloadedAt:
            result.downloadStatus === "complete"
              ? new Date().toISOString()
              : null,
        })
        .where(eq(media.id, rowId))
        .run();
    }

    sqlite
      .prepare(
        `UPDATE tests
         SET crawl_status = 'complete'
         WHERE crawl_status = 'partial'
           AND NOT EXISTS (
             SELECT 1
             FROM questions q
             JOIN entity_media em
               ON em.entity_type = 'question' AND em.entity_id = q.id
             JOIN media m ON m.id = em.media_id
             WHERE q.test_id = tests.id AND m.download_status != 'complete'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM parts p
             JOIN question_groups qg ON qg.part_id = p.id
             JOIN entity_media em
               ON em.entity_type = 'question_group' AND em.entity_id = qg.id
             JOIN media m ON m.id = em.media_id
             WHERE p.test_id = tests.id AND m.download_status != 'complete'
           )`,
      )
      .run();

    return {
      attempted: failedRows.length,
      completed,
      failed: failedRows.length - completed,
    };
  } finally {
    sqlite.close();
  }
}
