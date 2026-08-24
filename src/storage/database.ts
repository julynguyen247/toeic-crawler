import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AppConfig } from "../config.js";
import { ensureParent } from "../shared/files.js";
import * as schema from "./schema.js";

export function openDatabase(config: Pick<AppConfig, "databasePath">) {
  ensureParent(config.databasePath);
  const sqlite = new Database(config.databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

export function databaseExists(
  config: Pick<AppConfig, "databasePath">,
): boolean {
  return fs.existsSync(path.resolve(config.databasePath));
}
