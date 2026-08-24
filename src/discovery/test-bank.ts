import path from "node:path";
import { z } from "zod";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { SupabaseAdapter } from "../crawler/supabase-adapter.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";

const PAGE_SIZE = 1000;

const questionIndexSchema = z
  .object({
    id: z.string().uuid(),
    test_id: z.string().uuid(),
    question_number: z.number().int().positive(),
    part: z.number().int().min(1).max(7),
    source: z.string().nullable().optional(),
    pilot_status: z.string().nullable().optional(),
  })
  .passthrough();

export interface TestBankCandidate {
  testId: string;
  rowCount: number;
  uniqueQuestionCount: number;
  minQuestionNumber: number;
  maxQuestionNumber: number;
  parts: number[];
  sources: string[];
  pilotStatuses: string[];
  isComplete200: boolean;
}

async function fetchQuestionIndex(
  api: SupabaseAdapter,
): Promise<Array<z.infer<typeof questionIndexSchema>>> {
  const output: Array<z.infer<typeof questionIndexSchema>> = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = new URLSearchParams({
      select: "id,test_id,question_number,part,source,pilot_status",
      order: "test_id.asc,question_number.asc",
      offset: String(offset),
      limit: String(PAGE_SIZE),
    });
    const response = await api.get<unknown[]>(
      `/rest/v1/mock_test_questions?${query.toString()}`,
    );
    output.push(...z.array(questionIndexSchema).parse(response.data));
    if (response.data.length < PAGE_SIZE) {
      return output;
    }
  }
}

export async function discoverTestBank(config: AppConfig): Promise<{
  runId: string;
  candidates: TestBankCandidate[];
  completeCandidates: TestBankCandidate[];
  reportPath: string;
}> {
  const sessions = new SessionProvider(config);
  await sessions.initialize();
  const api = new SupabaseAdapter(config, sessions);
  const { runId, handle } = startRun(config, "test-bank-discovery", true);

  try {
    const rows = await fetchQuestionIndex(api);
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.test_id) ?? [];
      group.push(row);
      grouped.set(row.test_id, group);
    }
    const candidates = [...grouped]
      .map(([testId, questions]): TestBankCandidate => {
        const numbers = new Set(
          questions.map((question) => question.question_number),
        );
        const parts = [
          ...new Set(questions.map((question) => question.part)),
        ].sort((a, b) => a - b);
        const sortedNumbers = [...numbers].sort((a, b) => a - b);
        const sources = [
          ...new Set(
            questions
              .map((question) => question.source)
              .filter((value): value is string => Boolean(value)),
          ),
        ].sort();
        const pilotStatuses = [
          ...new Set(
            questions
              .map((question) => question.pilot_status)
              .filter((value): value is string => Boolean(value)),
          ),
        ].sort();
        const minQuestionNumber = sortedNumbers[0] ?? 0;
        const maxQuestionNumber = sortedNumbers.at(-1) ?? 0;
        return {
          testId,
          rowCount: questions.length,
          uniqueQuestionCount: numbers.size,
          minQuestionNumber,
          maxQuestionNumber,
          parts,
          sources,
          pilotStatuses,
          isComplete200:
            numbers.size === 200 &&
            minQuestionNumber === 1 &&
            maxQuestionNumber === 200 &&
            JSON.stringify(parts) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
        };
      })
      .sort((a, b) => a.testId.localeCompare(b.testId));
    const completeCandidates = candidates.filter(
      (candidate) => candidate.isComplete200,
    );
    const snapshot = saveRawSnapshot(
      config,
      runId,
      "test-bank-discovery",
      "all",
      { rowCount: rows.length, candidates },
    );
    recordSnapshot(handle, {
      runId,
      entityType: "test-bank-discovery",
      entitySourceId: "all",
      payloadPath: snapshot.relativePath,
      payloadSha256: snapshot.sha256,
    });
    ensureDirectory(config.reportDir);
    const reportPath = path.join(config.reportDir, `${runId}.json`);
    writeJsonAtomic(
      reportPath,
      {
        runId,
        status: "complete",
        mode: "test-bank-discovery",
        readOnly: true,
        sourceMutations: [],
        questionRows: rows.length,
        groupedTests: candidates.length,
        completeTests: completeCandidates.length,
        candidates,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    return { runId, candidates, completeCandidates, reportPath };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    handle.sqlite.close();
  }
}
