import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getConfig } from "../config.js";
import { openDatabase } from "./database.js";

export function runMigrations(): void {
  const config = getConfig();
  const { db, sqlite } = openDatabase(config);
  try {
    migrate(db, { migrationsFolder: path.resolve(config.cwd, "drizzle") });
  } finally {
    sqlite.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
  process.stdout.write("Database migrations complete.\n");
}
