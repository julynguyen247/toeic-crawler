import path from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { contentHash } from "../shared/checksum.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";
import { collections, tests } from "../storage/schema.js";
import { SupabaseAdapter } from "./supabase-adapter.js";

const collectionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable().optional(),
    year: z.number().nullable().optional(),
    order_index: z.number().nullable().optional(),
    is_hidden: z.boolean().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

const testSchema = z
  .object({
    id: z.string().uuid(),
    set_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable().optional(),
    difficulty_level: z.number().nullable().optional(),
    difficulty_label: z.string().nullable().optional(),
    total_questions: z.number().nullable().optional(),
    is_hidden: z.boolean().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export type SourceCollection = z.infer<typeof collectionSchema>;
export type SourceTest = z.infer<typeof testSchema>;

export interface CatalogSyncResult {
  runId: string;
  collections: SourceCollection[];
  tests: SourceTest[];
  reportPath: string;
}

export async function syncCatalog(
  config: AppConfig,
): Promise<CatalogSyncResult> {
  const sessions = new SessionProvider(config);
  await sessions.initialize();
  const api = new SupabaseAdapter(config, sessions);
  const { runId, handle } = startRun(config, "catalog-api", true);

  try {
    const [collectionResponse, testResponse] = await Promise.all([
      api.rpc<unknown[]>("list_public_mock_test_sets"),
      api.rpc<unknown[]>("list_public_mock_tests"),
    ]);
    const sourceCollections = z
      .array(collectionSchema)
      .parse(collectionResponse.data);
    const sourceTests = z.array(testSchema).parse(testResponse.data);
    const snapshot = saveRawSnapshot(config, runId, "catalog-api", "all", {
      collections: sourceCollections,
      tests: sourceTests,
    });
    recordSnapshot(handle, {
      runId,
      entityType: "catalog-api",
      entitySourceId: "all",
      payloadPath: snapshot.relativePath,
      payloadSha256: snapshot.sha256,
    });

    const now = new Date().toISOString();
    handle.db.transaction((tx) => {
      tx.update(collections)
        .set({ missingFromSource: true })
        .where(eq(collections.sourceSystem, "dautoeic"))
        .run();
      tx.update(tests).set({ missingFromSource: true }).run();

      const collectionIds = new Map<string, number>();
      for (const source of sourceCollections) {
        const row = tx
          .insert(collections)
          .values({
            sourceSystem: "dautoeic",
            sourceId: source.id,
            title: source.name,
            description: source.description ?? null,
            sourceUrl: `${config.sourceBaseUrl}/mock-test?set=${source.id}`,
            sourceUpdatedAt: source.updated_at ?? null,
            firstSeenRunId: runId,
            lastSeenRunId: runId,
            lastSeenAt: now,
            contentHash: contentHash(source),
            missingFromSource: false,
          })
          .onConflictDoUpdate({
            target: [collections.sourceSystem, collections.sourceId],
            set: {
              title: source.name,
              description: source.description ?? null,
              sourceUrl: `${config.sourceBaseUrl}/mock-test?set=${source.id}`,
              sourceUpdatedAt: source.updated_at ?? null,
              lastSeenRunId: runId,
              lastSeenAt: now,
              contentHash: contentHash(source),
              missingFromSource: false,
            },
          })
          .returning({ id: collections.id })
          .get();
        collectionIds.set(source.id, row.id);
      }

      for (const source of sourceTests) {
        const collectionId = collectionIds.get(source.set_id);
        if (!collectionId) {
          throw new Error(
            `Test ${source.id} references unknown collection ${source.set_id}.`,
          );
        }
        tx.insert(tests)
          .values({
            collectionId,
            sourceId: source.id,
            title: source.name,
            difficulty:
              source.difficulty_label ??
              source.difficulty_level?.toString() ??
              null,
            questionCount: source.total_questions ?? null,
            sourceUrl: `${config.sourceBaseUrl}/mock-test`,
            sourceUpdatedAt: source.updated_at ?? null,
            contentHash: contentHash(source),
            firstSeenRunId: runId,
            lastSeenRunId: runId,
            lastSeenAt: now,
            missingFromSource: false,
          })
          .onConflictDoUpdate({
            target: [tests.collectionId, tests.sourceId],
            set: {
              title: source.name,
              difficulty:
                source.difficulty_label ??
                source.difficulty_level?.toString() ??
                null,
              questionCount: source.total_questions ?? null,
              sourceUpdatedAt: source.updated_at ?? null,
              contentHash: contentHash(source),
              lastSeenRunId: runId,
              lastSeenAt: now,
              missingFromSource: false,
            },
          })
          .run();
      }
    });

    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    writeJsonAtomic(
      reportPath,
      {
        runId,
        status: "complete",
        mode: "catalog-api",
        readOnly: true,
        sourceMutations: [],
        collections: sourceCollections.length,
        tests: sourceTests.length,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    return {
      runId,
      collections: sourceCollections,
      tests: sourceTests,
      reportPath,
    };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}
