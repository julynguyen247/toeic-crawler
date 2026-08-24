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
const MAX_PAGINATION_ATTEMPTS = 3;

class SourceChangedDuringPaginationError extends Error {}

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

function totalFromContentRange(value: string | null): number | null {
  const total = value?.match(/\/(\d+)$/)?.[1];
  return total === undefined ? null : Number(total);
}

async function fetchExactQuestionCount(
  api: Pick<SupabaseAdapter, "get">,
): Promise<number> {
  const query = new URLSearchParams({ select: "id", limit: "1" });
  const response = await api.get<unknown[]>(
    `/rest/v1/mock_test_questions?${query.toString()}`,
    { headers: { Prefer: "count=exact" } },
  );
  const total = totalFromContentRange(response.contentRange);
  if (total === null) {
    throw new Error(
      "Question-bank discovery did not receive an exact source row count.",
    );
  }
  return total;
}

async function fetchQuestionIndexOnce(
  api: Pick<SupabaseAdapter, "get">,
): Promise<Array<z.infer<typeof questionIndexSchema>>> {
  const output: Array<z.infer<typeof questionIndexSchema>> = [];
  let startingTotal: number | null = null;
  let cursor: string | null = null;

  for (;;) {
    const query = new URLSearchParams({
      select: "id,test_id,question_number,part,source,pilot_status",
      order: "id.asc",
      limit: String(PAGE_SIZE),
    });
    if (cursor) {
      query.set("id", `gt.${cursor}`);
    }
    const response = await api.get<unknown[]>(
      `/rest/v1/mock_test_questions?${query.toString()}`,
      { headers: { Prefer: "count=exact" } },
    );
    if (startingTotal === null) {
      startingTotal = totalFromContentRange(response.contentRange);
      if (startingTotal === null) {
        throw new Error(
          "Question-bank discovery did not receive an exact source row count.",
        );
      }
    }

    const page = z.array(questionIndexSchema).parse(response.data);
    if (
      page.some((row, index) => {
        const previousId = index === 0 ? cursor : page[index - 1]!.id;
        return previousId !== null && row.id.localeCompare(previousId) <= 0;
      })
    ) {
      throw new Error(
        "Question-bank discovery received duplicate or unordered source IDs.",
      );
    }
    output.push(...page);
    cursor = page.at(-1)?.id ?? cursor;
    if (response.data.length < PAGE_SIZE) {
      break;
    }
  }

  const endingTotal = await fetchExactQuestionCount(api);
  if (output.length !== endingTotal) {
    throw new SourceChangedDuringPaginationError(
      `Question-bank discovery started at ${startingTotal} rows, ended at ${endingTotal}, and received ${output.length}.`,
    );
  }
  return output;
}

export async function fetchQuestionIndex(
  api: Pick<SupabaseAdapter, "get">,
): Promise<Array<z.infer<typeof questionIndexSchema>>> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetchQuestionIndexOnce(api);
    } catch (error) {
      if (
        !(error instanceof SourceChangedDuringPaginationError) ||
        attempt >= MAX_PAGINATION_ATTEMPTS
      ) {
        throw error;
      }
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
