import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import type { SupabaseAdapter } from "../src/crawler/supabase-adapter.js";
import { synchronizeSyntheticTestTitles } from "../src/crawler/test.js";
import { fetchQuestionIndex } from "../src/discovery/test-bank.js";
import { contentHash } from "../src/shared/checksum.js";
import { openDatabase } from "../src/storage/database.js";
import { temporaryConfig } from "./helpers.js";

function question(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    test_id: "10000000-0000-4000-8000-000000000000",
    question_number: (index % 200) + 1,
    part: 1,
    source: null,
    pilot_status: null,
  };
}

describe("test-bank pagination", () => {
  it("uses a unique keyset cursor and verifies the exact row count", async () => {
    const rows = Array.from({ length: 1001 }, (_, index) => question(index));
    const paths: string[] = [];
    const api = {
      async get<T>(path: string) {
        paths.push(path);
        const countOnly = path.includes("select=id&limit=1");
        const page = countOnly
          ? rows.slice(0, 1)
          : paths.length === 1
            ? rows.slice(0, 1000)
            : rows.slice(1000);
        return {
          data: page as T,
          status: 200,
          contentRange: countOnly
            ? "0-0/1001"
            : paths.length === 1
              ? "0-999/1001"
              : "1000-1000/1001",
        };
      },
    } as Pick<SupabaseAdapter, "get">;

    await expect(fetchQuestionIndex(api)).resolves.toHaveLength(1001);
    expect(paths[0]).toContain("order=id.asc");
    expect(paths[0]).not.toContain("offset=");
    expect(paths[1]).toContain(`id=gt.${encodeURIComponent(rows[999]!.id)}`);
  });

  it("resynchronizes synthetic titles without renaming catalog tests", () => {
    const config = temporaryConfig();
    const handle = openDatabase(config);
    migrate(handle.db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    handle.sqlite.exec(`
      INSERT INTO collections (id, source_id, title)
      VALUES (1, 'accessible-question-bank', 'Question bank'),
             (2, 'catalog', 'Catalog');
      INSERT INTO tests (
        collection_id, source_id, title, source_payload_json
      ) VALUES
        (1, 'synthetic-id', 'ETS Full Test 01', '{"name":"ETS Full Test 01"}'),
        (2, 'catalog-id', 'Official Test', '{"name":"Official Test"}');
    `);
    handle.sqlite.close();

    expect(
      synchronizeSyntheticTestTitles(config, [
        { testId: "catalog-id" },
        { testId: "synthetic-id" },
      ]),
    ).toBe(1);

    const checked = openDatabase(config);
    const rows = checked.sqlite
      .prepare(
        `SELECT title,
                json_extract(source_payload_json, '$.name') payloadName,
                content_hash contentHash
         FROM tests ORDER BY id`,
      )
      .all();
    checked.sqlite.close();
    expect(rows).toEqual([
      {
        title: "ETS Full Test 02",
        payloadName: "ETS Full Test 02",
        contentHash: contentHash({
          sourceTest: { name: "ETS Full Test 02" },
          sourceQuestions: [],
          sourcePassages: [],
        }),
      },
      {
        title: "Official Test",
        payloadName: "Official Test",
        contentHash: null,
      },
    ]);
  });

  it("fails instead of silently accepting an incomplete result", async () => {
    const api = {
      async get<T>() {
        return {
          data: [question(0)] as T,
          status: 200,
          contentRange: "0-0/2",
        };
      },
    } as Pick<SupabaseAdapter, "get">;

    await expect(fetchQuestionIndex(api)).rejects.toThrow(
      "ended at 2, and received 1",
    );
  });

  it("retries when rows are added behind the active cursor", async () => {
    let pageRequests = 0;
    const api = {
      async get<T>(path: string) {
        const countOnly = path.includes("select=id&limit=1");
        if (!countOnly) {
          pageRequests += 1;
        }
        const data = countOnly
          ? [question(0)]
          : pageRequests === 1
            ? [question(0)]
            : [question(0), question(1)];
        return {
          data: data as T,
          status: 200,
          contentRange: pageRequests === 1 && !countOnly ? "0-0/1" : "0-1/2",
        };
      },
    } as Pick<SupabaseAdapter, "get">;

    await expect(fetchQuestionIndex(api)).resolves.toHaveLength(2);
    expect(pageRequests).toBe(2);
  });
});
