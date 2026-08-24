import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { canonicalizeUrl } from "../shared/redact.js";
import { finishRun, startRun } from "../storage/run-repository.js";
import {
  contentRecordMedia,
  contentRecords,
  media,
} from "../storage/schema.js";
import {
  downloadMedia,
  type DownloadedMedia,
  type MediaCandidate,
} from "./media.js";

const BATCH_SIZE = 200;

interface Association {
  contentRecordId: number;
  purpose: string;
}

interface ContentMediaCandidate {
  sourceUrl: string;
  canonicalUrl: string;
  mediaType: "audio" | "image";
  associations: Association[];
}

export interface ContentMediaResult {
  runId: string;
  discovered: number;
  skippedExisting: number;
  attempted: number;
  completed: number;
  failed: number;
  downloadedBytes: number;
  stoppedForBudget: boolean;
  reportPath: string;
}

function extractMedia(
  value: unknown,
  pathSegments: string[] = [],
): Array<{ url: string; mediaType: "audio" | "image"; purpose: string }> {
  if (typeof value === "string") {
    if (!/^https?:\/\//i.test(value)) {
      return [];
    }
    const fieldPath = pathSegments.join(".");
    if (/video|youtube/i.test(fieldPath)) {
      return [];
    }
    if (/audio/i.test(fieldPath)) {
      return [{ url: value, mediaType: "audio", purpose: fieldPath }];
    }
    if (/image|thumbnail|diagram|cover/i.test(fieldPath)) {
      return [{ url: value, mediaType: "image", purpose: fieldPath }];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      extractMedia(entry, [...pathSegments, String(index)]),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      extractMedia(entry, [...pathSegments, key]),
    );
  }
  return [];
}

function freeBytes(cwd: string): number {
  const stats = fs.statfsSync(cwd);
  return stats.bavail * stats.bsize;
}

function storeDownloaded(
  handle: ReturnType<typeof startRun>["handle"],
  downloaded: DownloadedMedia,
): number {
  const existing = handle.db
    .select({ id: media.id })
    .from(media)
    .where(eq(media.canonicalUrl, downloaded.canonicalUrl))
    .get();
  const values = {
    provider: downloaded.provider,
    bucket: downloaded.bucket,
    objectPath: downloaded.objectPath,
    canonicalUrl: downloaded.canonicalUrl,
    localPath: downloaded.localPath,
    mediaType: downloaded.mediaType,
    mimeType: downloaded.mimeType,
    sha256: downloaded.sha256,
    byteSize: downloaded.byteSize,
    downloadStatus: downloaded.downloadStatus,
    lastDownloadedAt:
      downloaded.downloadStatus === "complete"
        ? new Date().toISOString()
        : null,
  };
  if (existing) {
    handle.db.update(media).set(values).where(eq(media.id, existing.id)).run();
    return existing.id;
  }
  if (
    downloaded.provider === "supabase-storage" &&
    downloaded.bucket &&
    downloaded.objectPath
  ) {
    return handle.db
      .insert(media)
      .values(values)
      .onConflictDoUpdate({
        target: [media.provider, media.bucket, media.objectPath],
        set: values,
      })
      .returning({ id: media.id })
      .get().id;
  }
  return handle.db
    .insert(media)
    .values(values)
    .returning({ id: media.id })
    .get().id;
}

function linkAssociations(
  handle: ReturnType<typeof startRun>["handle"],
  mediaId: number,
  associations: Association[],
): void {
  for (const association of associations) {
    handle.db
      .insert(contentRecordMedia)
      .values({
        contentRecordId: association.contentRecordId,
        mediaId,
        purpose: association.purpose,
      })
      .onConflictDoNothing()
      .run();
  }
}

export async function crawlContentMedia(
  config: AppConfig,
  options: { maxBytes: number; minFreeBytes: number },
): Promise<ContentMediaResult> {
  const { runId, handle } = startRun(config, "content-media", true);
  try {
    const groups = new Map<string, ContentMediaCandidate>();
    const rows = handle.db
      .select({
        id: contentRecords.id,
        sourceTable: contentRecords.sourceTable,
        payloadJson: contentRecords.payloadJson,
      })
      .from(contentRecords)
      .where(eq(contentRecords.missingFromSource, false))
      .all();
    for (const row of rows) {
      const payload = JSON.parse(row.payloadJson) as unknown;
      for (const item of extractMedia(payload)) {
        const canonicalUrl = canonicalizeUrl(item.url);
        const association = {
          contentRecordId: row.id,
          purpose: `${row.sourceTable}.${item.purpose}`,
        };
        const existing = groups.get(canonicalUrl);
        if (existing) {
          existing.associations.push(association);
        } else {
          groups.set(canonicalUrl, {
            sourceUrl: item.url,
            canonicalUrl,
            mediaType: item.mediaType,
            associations: [association],
          });
        }
      }
    }

    const existingMedia = new Map(
      handle.db
        .select({
          id: media.id,
          canonicalUrl: media.canonicalUrl,
          status: media.downloadStatus,
        })
        .from(media)
        .all()
        .filter((row): row is typeof row & { canonicalUrl: string } =>
          Boolean(row.canonicalUrl),
        )
        .map((row) => [row.canonicalUrl, row]),
    );
    let skippedExisting = 0;
    const queue: ContentMediaCandidate[] = [];
    for (const candidate of groups.values()) {
      const existing = existingMedia.get(candidate.canonicalUrl);
      if (existing?.status === "complete") {
        skippedExisting += 1;
        linkAssociations(handle, existing.id, candidate.associations);
      } else {
        queue.push(candidate);
      }
    }

    let attempted = 0;
    let completed = 0;
    let failed = 0;
    let downloadedBytes = 0;
    let stoppedForBudget = false;
    const downloadConfig: AppConfig = {
      ...config,
      mediaConcurrency: Math.max(config.mediaConcurrency, 16),
    };
    for (let index = 0; index < queue.length; index += BATCH_SIZE) {
      if (
        downloadedBytes >= options.maxBytes ||
        freeBytes(config.cwd) <= options.minFreeBytes
      ) {
        stoppedForBudget = true;
        break;
      }
      const batch = queue.slice(index, index + BATCH_SIZE);
      const mediaCandidates: MediaCandidate[] = batch.map((candidate) => ({
        sourceUrl: candidate.sourceUrl,
        references: [],
        mediaType: candidate.mediaType,
      }));
      const results = await downloadMedia(downloadConfig, mediaCandidates);
      attempted += results.length;
      handle.db.transaction(() => {
        for (const result of results) {
          const candidate = groups.get(result.canonicalUrl);
          if (!candidate) {
            continue;
          }
          const mediaId = storeDownloaded(handle, result);
          linkAssociations(handle, mediaId, candidate.associations);
          if (result.downloadStatus === "complete") {
            completed += 1;
            downloadedBytes += result.byteSize ?? 0;
          } else {
            failed += 1;
          }
        }
      });
    }

    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    const result: ContentMediaResult = {
      runId,
      discovered: groups.size,
      skippedExisting,
      attempted,
      completed,
      failed,
      downloadedBytes,
      stoppedForBudget,
      reportPath,
    };
    writeJsonAtomic(
      reportPath,
      {
        ...result,
        status: failed || stoppedForBudget ? "partial" : "complete",
        mode: "content-media",
        readOnly: true,
        sourceMutations: [],
      },
      0o644,
    );
    finishRun(
      handle,
      runId,
      failed || stoppedForBudget ? "partial" : "complete",
      failed ? [{ message: `${failed} media download(s) failed.` }] : [],
    );
    return result;
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}
