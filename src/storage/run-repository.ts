import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import { REDACTION_VERSION } from "../shared/redact.js";
import { openDatabase } from "./database.js";
import { crawlRuns, sourceSnapshots } from "./schema.js";

export type DatabaseHandle = ReturnType<typeof openDatabase>;

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

export function startRun(
  config: AppConfig,
  mode: string,
  readOnly: boolean,
): { runId: string; handle: DatabaseHandle } {
  const handle = openDatabase(config);
  const runId = newRunId();
  handle.db
    .insert(crawlRuns)
    .values({ id: runId, mode, status: "running", readOnly })
    .run();
  return { runId, handle };
}

export function finishRun(
  handle: DatabaseHandle,
  runId: string,
  status: "complete" | "partial" | "failed",
  errors: unknown[] = [],
): void {
  handle.db
    .update(crawlRuns)
    .set({
      status,
      finishedAt: new Date().toISOString(),
      errorSummaryJson: JSON.stringify(errors),
    })
    .where(eq(crawlRuns.id, runId))
    .run();
}

export function recordSnapshot(
  handle: DatabaseHandle,
  values: {
    runId: string;
    entityType: string;
    entitySourceId: string;
    payloadPath: string;
    payloadSha256: string;
  },
): void {
  handle.db
    .insert(sourceSnapshots)
    .values({
      crawlRunId: values.runId,
      entityType: values.entityType,
      entitySourceId: values.entitySourceId,
      payloadPath: values.payloadPath,
      payloadSha256: values.payloadSha256,
      redactionVersion: REDACTION_VERSION,
    })
    .onConflictDoNothing()
    .run();
}
