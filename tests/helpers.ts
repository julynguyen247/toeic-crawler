import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { AppConfig } from "../src/config.js";

export function temporaryConfig(): AppConfig {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dautoeic-crawler-test-"));
  return {
    cwd,
    sourceBaseUrl: "https://dautoeic.com",
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "public-anon-key-with-enough-characters",
    supabaseProjectRef: "example",
    authStatePath: path.join(cwd, ".auth", "storage-state.json"),
    authSessionPath: path.join(cwd, ".auth", "session.json"),
    databasePath: path.join(cwd, "data", "toeic.sqlite"),
    mediaDir: path.join(cwd, "data", "media"),
    rawSnapshotDir: path.join(cwd, "data", "raw"),
    reportDir: path.join(cwd, "data", "reports"),
    requestDelayMs: 0,
    mediaConcurrency: 2,
    headless: true,
    logLevel: "silent",
    crawler: {
      collections: [],
      tests: [],
      allowSourceMutations: false,
      allowedRequests: [
        { method: "GET", pathPrefix: "/rest/v1/" },
        { method: "POST", pathPrefix: "/rest/v1/rpc/" },
      ],
      readOnlyPostEndpoints: ["/rest/v1/rpc/read_test"],
    },
  };
}
