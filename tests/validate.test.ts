import fs from "node:fs";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/database.js";
import { validateDatabase } from "../src/storage/validate.js";
import { temporaryConfig } from "./helpers.js";

describe("database validation", () => {
  it("reports files in the media directory that are not tracked by SQLite", () => {
    const config = temporaryConfig();
    const handle = openDatabase(config);
    migrate(handle.db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    handle.sqlite
      .prepare(
        `INSERT INTO media (
           provider, canonical_url, media_type, download_status
         ) VALUES (?, ?, ?, ?)`,
      )
      .run("https", "https://cdn.example/orphan.mp3", "audio", "pending");
    handle.sqlite.close();

    fs.mkdirSync(config.mediaDir, { recursive: true });
    fs.writeFileSync(path.join(config.mediaDir, "orphan.partial"), "partial");

    expect(validateDatabase(config).untrackedMediaFiles).toEqual([
      "data/media/orphan.partial",
    ]);
    expect(validateDatabase(config).completeness.orphanMediaRows).toEqual({
      count: 1,
      samples: ["https://cdn.example/orphan.mp3"],
    });
  });
});
