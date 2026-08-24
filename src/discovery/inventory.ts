import path from "node:path";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { SupabaseAdapter } from "../crawler/supabase-adapter.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { finishRun, startRun } from "../storage/run-repository.js";

const CONTENT_TABLES = [
  "grammar_topics",
  "grammar_subtopics",
  "lessons",
  "questions",
  "listening_sets",
  "listening_items",
  "listening_collection_order",
  "listening_chapter_order",
  "topic_listening_sets",
  "topic_listening_items",
  "pronunciation_lessons",
  "reading_passages",
  "vocabulary_sets",
  "vocabulary_tests",
  "vocabulary_parts",
  "vocabulary_words",
  "video_chapters",
  "video_lessons",
  "lesson_quiz_questions",
  "lesson_schedule",
  "lesson_day_names",
  "blog_articles",
] as const;

export interface InventoryEntry {
  table: string;
  count: number | null;
  columns: string[];
  error: string | null;
}

function totalFromContentRange(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const total = value.match(/\/(\d+)$/)?.[1];
  return total ? Number(total) : null;
}

export async function inventoryContent(
  config: AppConfig,
): Promise<{ runId: string; entries: InventoryEntry[]; reportPath: string }> {
  const sessions = new SessionProvider(config);
  await sessions.initialize();
  const api = new SupabaseAdapter(config, sessions);
  const { runId, handle } = startRun(config, "content-inventory", true);
  const entries: InventoryEntry[] = [];

  try {
    for (const table of CONTENT_TABLES) {
      try {
        const response = await api.get<Array<Record<string, unknown>>>(
          `/rest/v1/${table}?select=*&limit=1`,
          { headers: { Prefer: "count=exact" } },
        );
        entries.push({
          table,
          count: totalFromContentRange(response.contentRange),
          columns: Object.keys(response.data[0] ?? {}).sort(),
          error: null,
        });
      } catch (error) {
        entries.push({
          table,
          count: null,
          columns: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    writeJsonAtomic(
      reportPath,
      {
        runId,
        status: "complete",
        mode: "content-inventory",
        readOnly: true,
        sourceMutations: [],
        entries,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    return { runId, entries, reportPath };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}
