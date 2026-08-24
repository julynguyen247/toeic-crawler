import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ quiet: true });

const booleanFromString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const envSchema = z.object({
  SOURCE_BASE_URL: z.url().default("https://dautoeic.com"),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  AUTH_STATE_PATH: z.string().default(".auth/storage-state.json"),
  AUTH_SESSION_PATH: z.string().default(".auth/session.json"),
  DATABASE_PATH: z.string().default("data/toeic.sqlite"),
  MEDIA_DIR: z.string().default("data/media"),
  RAW_SNAPSHOT_DIR: z.string().default("data/raw"),
  REPORT_DIR: z.string().default("data/reports"),
  REQUEST_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  MEDIA_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  HEADLESS: booleanFromString,
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
});

const requestRuleSchema = z.object({
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  pathPrefix: z.string().startsWith("/"),
});

const crawlerConfigSchema = z.object({
  collections: z.array(z.string()).default([]),
  tests: z.array(z.string()).default([]),
  allowSourceMutations: z.boolean().default(false),
  allowedRequests: z.array(requestRuleSchema).default([]),
  readOnlyPostEndpoints: z.array(z.string().startsWith("/")).default([]),
});

export type CrawlerConfig = z.infer<typeof crawlerConfigSchema>;

export interface AppConfig {
  cwd: string;
  sourceBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseProjectRef: string;
  authStatePath: string;
  authSessionPath: string;
  databasePath: string;
  mediaDir: string;
  rawSnapshotDir: string;
  reportDir: string;
  requestDelayMs: number;
  mediaConcurrency: number;
  headless: boolean;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
  crawler: CrawlerConfig;
}

function absolute(cwd: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

function projectRefFromUrl(url: string): string {
  const hostname = new URL(url).hostname;
  const suffix = ".supabase.co";
  if (!hostname.endsWith(suffix)) {
    throw new Error(
      `SUPABASE_URL must use a supabase.co hostname, got ${hostname}`,
    );
  }
  return hostname.slice(0, -suffix.length);
}

export function getConfig(cwd = process.cwd()): AppConfig {
  const env = envSchema.parse(process.env);
  const crawlerConfigPath = path.resolve(cwd, "crawler.config.json");
  const crawlerJson = fs.existsSync(crawlerConfigPath)
    ? JSON.parse(fs.readFileSync(crawlerConfigPath, "utf8"))
    : {};

  return {
    cwd,
    sourceBaseUrl: env.SOURCE_BASE_URL.replace(/\/$/, ""),
    supabaseUrl: env.SUPABASE_URL.replace(/\/$/, ""),
    supabaseAnonKey: env.SUPABASE_ANON_KEY,
    supabaseProjectRef: projectRefFromUrl(env.SUPABASE_URL),
    authStatePath: absolute(cwd, env.AUTH_STATE_PATH),
    authSessionPath: absolute(cwd, env.AUTH_SESSION_PATH),
    databasePath: absolute(cwd, env.DATABASE_PATH),
    mediaDir: absolute(cwd, env.MEDIA_DIR),
    rawSnapshotDir: absolute(cwd, env.RAW_SNAPSHOT_DIR),
    reportDir: absolute(cwd, env.REPORT_DIR),
    requestDelayMs: env.REQUEST_DELAY_MS,
    mediaConcurrency: env.MEDIA_CONCURRENCY,
    headless: env.HEADLESS,
    logLevel: env.LOG_LEVEL,
    crawler: crawlerConfigSchema.parse(crawlerJson),
  };
}
