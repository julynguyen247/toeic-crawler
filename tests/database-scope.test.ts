import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { collections, crawlRuns, tests } from "../src/storage/schema.js";
import { temporaryConfig } from "./helpers.js";

describe("database source identity", () => {
  it("scopes repeated source IDs by parent collection", () => {
    const config = temporaryConfig();
    const handle = openDatabase(config);
    try {
      migrate(handle.db, {
        migrationsFolder: path.resolve(process.cwd(), "drizzle"),
      });
      handle.db
        .insert(crawlRuns)
        .values({ id: "run-1", mode: "test", status: "running" })
        .run();
      handle.db
        .insert(collections)
        .values([
          {
            sourceId: "collection-a",
            title: "A",
            firstSeenRunId: "run-1",
            lastSeenRunId: "run-1",
          },
          {
            sourceId: "collection-b",
            title: "B",
            firstSeenRunId: "run-1",
            lastSeenRunId: "run-1",
          },
        ])
        .run();
      const savedCollections = handle.db.select().from(collections).all();
      handle.db
        .insert(tests)
        .values(
          savedCollections.map((collection) => ({
            collectionId: collection.id,
            sourceId: "same-test-id",
            title: "Test 1",
            firstSeenRunId: "run-1",
            lastSeenRunId: "run-1",
          })),
        )
        .run();

      expect(handle.db.select().from(tests).all()).toHaveLength(2);
    } finally {
      handle.sqlite.close();
    }
  });
});
