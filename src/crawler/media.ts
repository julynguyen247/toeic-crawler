import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AppConfig } from "../config.js";
import { ensureDirectory } from "../shared/files.js";
import { canonicalizeUrl } from "../shared/redact.js";

export interface MediaReference {
  entityType: "question" | "question_group";
  entitySourceId: string;
  purpose: "listening_audio" | "prompt_image";
}

export interface MediaCandidate {
  sourceUrl: string;
  references: MediaReference[];
  mediaType?: "audio" | "image";
}

export interface DownloadedMedia {
  sourceUrl: string;
  provider: "supabase-storage" | "external";
  bucket: string | null;
  objectPath: string | null;
  canonicalUrl: string;
  localPath: string | null;
  mediaType: "audio" | "image";
  mimeType: string | null;
  sha256: string | null;
  byteSize: number | null;
  downloadStatus: "complete" | "failed";
  error: string | null;
  references: MediaReference[];
}

function parseStorageLocator(config: AppConfig, sourceUrl: string) {
  const url = new URL(sourceUrl);
  const expectedOrigin = new URL(config.supabaseUrl).origin;
  const match = url.pathname.match(
    /^\/storage\/v1\/object\/(?:public|sign)\/([^/]+)\/(.+)$/,
  );
  if (url.origin === expectedOrigin && match) {
    return {
      provider: "supabase-storage" as const,
      bucket: decodeURIComponent(match[1]!),
      objectPath: match[2]!
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/"),
    };
  }
  return { provider: "external" as const, bucket: null, objectPath: null };
}

function extensionFor(url: string, mimeType: string | null): string {
  const byMime: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  const normalizedMime =
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (normalizedMime && byMime[normalizedMime]) {
    return byMime[normalizedMime];
  }
  const extension = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

function candidateKey(config: AppConfig, sourceUrl: string): string {
  const locator = parseStorageLocator(config, sourceUrl);
  return locator.provider === "supabase-storage"
    ? `${locator.provider}:${locator.bucket}:${locator.objectPath}`
    : canonicalizeUrl(sourceUrl);
}

export function mergeMediaCandidates(
  config: AppConfig,
  candidates: MediaCandidate[],
): MediaCandidate[] {
  const merged = new Map<string, MediaCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(config, candidate.sourceUrl);
    const existing = merged.get(key);
    if (existing) {
      const seen = new Set(
        existing.references.map((reference) => JSON.stringify(reference)),
      );
      for (const reference of candidate.references) {
        const serialized = JSON.stringify(reference);
        if (!seen.has(serialized)) {
          existing.references.push(reference);
          seen.add(serialized);
        }
      }
    } else {
      merged.set(key, {
        sourceUrl: candidate.sourceUrl,
        references: [...candidate.references],
        ...(candidate.mediaType ? { mediaType: candidate.mediaType } : {}),
      });
    }
  }
  return [...merged.values()];
}

async function downloadOne(
  config: AppConfig,
  candidate: MediaCandidate,
): Promise<DownloadedMedia> {
  const locator = parseStorageLocator(config, candidate.sourceUrl);
  const canonicalUrl = canonicalizeUrl(candidate.sourceUrl);
  const mediaType =
    candidate.mediaType ??
    (candidate.references.some(
      (reference) => reference.purpose === "listening_audio",
    )
      ? "audio"
      : "image");
  ensureDirectory(config.mediaDir);
  const temporaryPath = path.join(
    config.mediaDir,
    `${process.pid}-${crypto.randomUUID()}.partial`,
  );

  try {
    const response = await fetch(candidate.sourceUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    const mimeType = response.headers.get("content-type");
    const hash = crypto.createHash("sha256");
    let byteSize = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        byteSize += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      meter,
      fs.createWriteStream(temporaryPath, { flags: "wx" }),
    );
    const digest = hash.digest("hex");
    const extension = extensionFor(candidate.sourceUrl, mimeType);
    const finalPath = path.join(config.mediaDir, `${digest}.${extension}`);
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(temporaryPath);
    } else {
      fs.renameSync(temporaryPath, finalPath);
    }
    return {
      sourceUrl: candidate.sourceUrl,
      ...locator,
      canonicalUrl,
      localPath: path.relative(config.cwd, finalPath),
      mediaType,
      mimeType,
      sha256: digest,
      byteSize,
      downloadStatus: "complete",
      error: null,
      references: candidate.references,
    };
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw cleanupError;
      }
    }
    return {
      sourceUrl: candidate.sourceUrl,
      ...locator,
      canonicalUrl,
      localPath: null,
      mediaType,
      mimeType: null,
      sha256: null,
      byteSize: null,
      downloadStatus: "failed",
      error: error instanceof Error ? error.message : String(error),
      references: candidate.references,
    };
  }
}

export async function downloadMedia(
  config: AppConfig,
  candidates: MediaCandidate[],
): Promise<DownloadedMedia[]> {
  const queue = mergeMediaCandidates(config, candidates);
  const output: DownloadedMedia[] = new Array(queue.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(config.mediaConcurrency, queue.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const candidate = queue[index];
        if (!candidate) {
          return;
        }
        output[index] = await downloadOne(config, candidate);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
