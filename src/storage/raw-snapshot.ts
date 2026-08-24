import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { AppConfig } from "../config.js";
import { ensureDirectory } from "../shared/files.js";
import { redact } from "../shared/redact.js";

export interface SnapshotResult {
  absolutePath: string;
  relativePath: string;
  sha256: string;
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 100) || "snapshot";
}

export function saveRawSnapshot(
  config: AppConfig,
  runId: string,
  entityType: string,
  entitySourceId: string,
  payload: unknown,
): SnapshotResult {
  const redacted = redact(payload);
  const serialized = Buffer.from(
    `${JSON.stringify(redacted, null, 2)}\n`,
    "utf8",
  );
  const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
  const directory = path.join(config.rawSnapshotDir, safeSegment(runId));
  ensureDirectory(directory);
  const fileName = `${safeSegment(entityType)}-${safeSegment(entitySourceId)}-${sha256.slice(0, 12)}.json.gz`;
  const absolutePath = path.join(directory, fileName);
  fs.writeFileSync(absolutePath, zlib.gzipSync(serialized, { level: 9 }));

  return {
    absolutePath,
    relativePath: path.relative(config.cwd, absolutePath),
    sha256,
  };
}
