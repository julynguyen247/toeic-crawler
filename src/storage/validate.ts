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
    return {
      integrity: integrityRow.integrity_check,
      foreignKeyViolations,
      missingMediaFiles,
      checksumMismatches,
    };
  } finally {
    sqlite.close();
  }
}
