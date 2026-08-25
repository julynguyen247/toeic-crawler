#!/usr/bin/env node
import { Command } from "commander";
import { getConfig } from "./config.js";
import { clearSavedAuth } from "./auth/session-store.js";
import { runInteractiveLogin } from "./auth/login.js";
import { discoverCatalog } from "./discovery/catalog.js";
import { inspectTest } from "./discovery/inspect-test.js";
import { discoverSite } from "./discovery/site.js";
import { discoverTestBank } from "./discovery/test-bank.js";
import { inventoryContent } from "./discovery/inventory.js";
import { syncCatalog } from "./crawler/catalog.js";
import { crawlContent } from "./crawler/content.js";
import { crawlContentMedia } from "./crawler/content-media.js";
import { retryFailedMedia } from "./crawler/retry-media.js";
import {
  completedTestSourceIds,
  crawlTest,
  synchronizeSyntheticTestTitles,
} from "./crawler/test.js";
import { createLogger } from "./shared/logger.js";
import { runMigrations } from "./storage/migrate.js";
import { validateDatabase } from "./storage/validate.js";
import { exportDatabaseToJson } from "./storage/export-json.js";
import { exportTestsToSeparateJson } from "./storage/export-tests.js";
import { enrichStoredQuestions } from "./storage/enrich-questions.js";
import { enrichStoredQuestionGroups } from "./storage/enrich-question-groups.js";

const program = new Command();
program
  .name("dautoeic-crawler")
  .description("Authorized crawler for dautoeic.com")
  .version("0.1.0");

program
  .command("auth")
  .description(
    "Open Chrome for manual Google OAuth and save the resulting Supabase session",
  )
  .action(async () => {
    await runInteractiveLogin(getConfig());
  });

program
  .command("auth-clear")
  .description("Remove locally saved browser and Supabase sessions")
  .action(() => {
    const removed = clearSavedAuth(getConfig());
    process.stdout.write(
      removed.length
        ? `Đã xóa ${removed.length} file session local.\n`
        : "Không có session local.\n",
    );
  });

const crawl = program
  .command("crawl")
  .description("Run an authorized crawl or discovery command");

crawl
  .command("catalog")
  .description(
    "Synchronize the authorized test catalog through read-only Supabase RPCs",
  )
  .action(async () => {
    runMigrations();
    const result = await syncCatalog(getConfig());
    process.stdout.write(
      `Catalog: ${result.collections.length} collection(s), ${result.tests.length} test(s).\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("catalog-browser")
  .description("Capture browser catalog traffic for discovery/debugging")
  .action(async () => {
    runMigrations();
    const result = await discoverCatalog(getConfig());
    process.stdout.write(
      `Browser catalog: ${result.collections.length} collection(s), ${result.tests.length} test(s), ${result.capturedResponses} Supabase response(s), ${result.blockedRequests} blocked request(s).\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("discover-site")
  .description("Scan major learning areas and summarize read-only traffic")
  .action(async () => {
    runMigrations();
    const result = await discoverSite(getConfig());
    process.stdout.write(
      `Site discovery: ${result.routes.length} routes, ${result.endpointSummary.length} read endpoint(s), ${result.blockedEndpointSummary.length} blocked endpoint(s).\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("inventory")
  .description(
    "Count content rows and record visible columns without mutations",
  )
  .action(async () => {
    runMigrations();
    const result = await inventoryContent(getConfig());
    for (const entry of result.entries) {
      process.stdout.write(
        `${entry.table}: ${entry.error ? `error (${entry.error})` : (entry.count ?? "unknown")}\n`,
      );
    }
    process.stdout.write(`Report: ${result.reportPath}\n`);
  });

crawl
  .command("discover-test-bank")
  .description("Group every readable mock-test question by source test ID")
  .action(async () => {
    runMigrations();
    const result = await discoverTestBank(getConfig());
    process.stdout.write(
      `Test bank: ${result.candidates.length} grouped test ID(s), ${result.completeCandidates.length} complete 200-question test(s).\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("test")
  .description(
    "Crawl and normalize one test through read-only Supabase table queries",
  )
  .requiredOption("--test-id <uuid>", "Supabase mock_tests ID")
  .action(async (options: { testId: string }) => {
    runMigrations();
    const result = await crawlTest(getConfig(), options.testId);
    process.stdout.write(
      `${result.title}: ${result.questions} questions, ${result.passages} passages, ${result.mediaComplete} media downloaded, ${result.mediaFailed} media failed.\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("content")
  .description(
    "Crawl all visible grammar, listening, reading, vocabulary, video, and blog content",
  )
  .action(async () => {
    runMigrations();
    const result = await crawlContent(getConfig());
    process.stdout.write(
      `Content crawl: ${result.totalRecords} record(s) across ${Object.keys(result.counts).length} source table(s).\nReport: ${result.reportPath}\n`,
    );
  });

crawl
  .command("content-media")
  .description("Download media referenced by the extended content archive")
  .option("--budget-mb <number>", "Maximum new bytes to download", "2048")
  .option(
    "--min-free-mb <number>",
    "Stop before available disk space falls below this value",
    "1024",
  )
  .action(async (options: { budgetMb: string; minFreeMb: string }) => {
    runMigrations();
    const budgetMb = Number(options.budgetMb);
    const minFreeMb = Number(options.minFreeMb);
    if (!(budgetMb > 0) || !(minFreeMb > 0)) {
      throw new Error(
        "--budget-mb and --min-free-mb must be positive numbers.",
      );
    }
    const result = await crawlContentMedia(getConfig(), {
      maxBytes: budgetMb * 1024 * 1024,
      minFreeBytes: minFreeMb * 1024 * 1024,
    });
    process.stdout.write(
      `Content media: ${result.discovered} discovered, ${result.skippedExisting} existing, ${result.completed}/${result.attempted} downloaded, ${result.failed} failed, ${(result.downloadedBytes / 1024 / 1024).toFixed(1)} MiB new${result.stoppedForBudget ? ", stopped at disk/budget guard" : ""}.\nReport: ${result.reportPath}\n`,
    );
    if (result.failed) {
      process.exitCode = 1;
    }
  });

crawl
  .command("all")
  .description("Crawl configured tests, or every discovered test when opted in")
  .option(
    "--all-discovered",
    "Crawl every test returned by the authorized catalog",
    false,
  )
  .option("--resume", "Skip tests already marked complete", false)
  .action(async (options: { allDiscovered: boolean; resume: boolean }) => {
    runMigrations();
    const config = getConfig();
    const catalog = await syncCatalog(config);
    const selected = options.allDiscovered
      ? catalog.tests
      : config.crawler.tests.map((selector) => {
          const matches = catalog.tests.filter(
            (test) => test.id === selector || test.name === selector,
          );
          if (matches.length !== 1) {
            throw new Error(
              `Configured test selector ${JSON.stringify(selector)} matched ${matches.length} catalog tests.`,
            );
          }
          return matches[0]!;
        });
    if (!selected.length) {
      throw new Error(
        "No tests selected. Add test IDs/titles to crawler.config.json or pass --all-discovered.",
      );
    }

    const completed = options.resume
      ? completedTestSourceIds(config)
      : new Set<string>();
    const queue = selected.filter((test) => !completed.has(test.id));
    const failures: Array<{ testId: string; error: string }> = [];
    let succeeded = 0;
    process.stdout.write(
      `Selected ${selected.length} test(s); ${selected.length - queue.length} skipped; ${queue.length} queued.\n`,
    );
    for (const [index, test] of queue.entries()) {
      process.stdout.write(
        `[${index + 1}/${queue.length}] Crawling ${test.name} (${test.id})...\n`,
      );
      try {
        const result = await crawlTest(config, test.id, {
          syncCatalogFirst: false,
        });
        succeeded += 1;
        process.stdout.write(
          `  Done: ${result.questions} questions, ${result.mediaComplete} media, ${result.mediaFailed} media failed.\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ testId: test.id, error: message });
        process.stderr.write(`  Failed: ${message}\n`);
      }
    }
    process.stdout.write(
      `All crawl finished: ${succeeded} succeeded, ${failures.length} failed, ${selected.length - queue.length} skipped.\n`,
    );
    if (failures.length) {
      process.exitCode = 1;
    }
  });

crawl
  .command("test-bank")
  .description(
    "Crawl every complete 200-question test readable from the mock-test question bank",
  )
  .option("--with-media", "Download audio/images while crawling", false)
  .option("--resume", "Skip tests already marked complete", false)
  .action(async (options: { withMedia: boolean; resume: boolean }) => {
    runMigrations();
    const config = getConfig();
    const discovery = await discoverTestBank(config);
    const renamedTests = synchronizeSyntheticTestTitles(
      config,
      discovery.completeCandidates,
    );
    const completed = options.resume
      ? completedTestSourceIds(config)
      : new Set<string>();
    const queue = discovery.completeCandidates.filter(
      (candidate) => !completed.has(candidate.testId),
    );
    let succeeded = 0;
    const failures: Array<{ testId: string; error: string }> = [];
    process.stdout.write(
      `Test bank selected ${discovery.completeCandidates.length} complete test(s); ${discovery.completeCandidates.length - queue.length} skipped; ${queue.length} queued; ${renamedTests} synthetic title(s) synchronized.\n`,
    );
    for (const candidate of queue) {
      const catalogIndex =
        discovery.completeCandidates.findIndex(
          (entry) => entry.testId === candidate.testId,
        ) + 1;
      const title = `ETS Full Test ${String(catalogIndex).padStart(2, "0")}`;
      process.stdout.write(
        `[${succeeded + failures.length + 1}/${queue.length}] ${title}...\n`,
      );
      try {
        const result = await crawlTest(config, candidate.testId, {
          syncCatalogFirst: false,
          downloadMedia: options.withMedia,
          syntheticTitle: title,
        });
        succeeded += 1;
        process.stdout.write(
          `  Done: ${result.questions} questions, ${result.passages} passages${result.mediaSkipped ? `, ${result.mediaSkipped} media URL(s) preserved without download` : `, ${result.mediaComplete} media downloaded`}.\n`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ testId: candidate.testId, error: message });
        process.stderr.write(`  Failed: ${message}\n`);
      }
    }
    process.stdout.write(
      `Test bank finished: ${succeeded} succeeded, ${failures.length} failed, ${discovery.completeCandidates.length - queue.length} skipped.\n`,
    );
    if (failures.length) {
      process.exitCode = 1;
    }
  });

crawl
  .command("retry-media")
  .description("Retry media rows whose previous download failed")
  .action(async () => {
    runMigrations();
    const result = await retryFailedMedia(getConfig());
    process.stdout.write(
      `Media retry: ${result.attempted} attempted, ${result.completed} completed, ${result.failed} failed.\n`,
    );
    if (result.failed) {
      process.exitCode = 1;
    }
  });

crawl
  .command("inspect")
  .description(
    "Open one test in practice mode and capture its authorized Supabase traffic",
  )
  .requiredOption("--test-title <title>", "Visible title, for example 'Test 1'")
  .option("--headed", "Show the browser while inspecting", false)
  .action(async (options: { testTitle: string; headed: boolean }) => {
    runMigrations();
    const result = await inspectTest(getConfig(), options);
    process.stdout.write(
      `Inspect captured ${result.capturedResponses} Supabase response(s), blocked ${result.blockedRequests} request(s), at ${result.pageUrl}.\nReport: ${result.reportPath}\n`,
    );
  });

program
  .command("enrich")
  .description(
    "Backfill explanations, image alt text/OCR, and TOEIC skill tags",
  )
  .action(async () => {
    runMigrations();
    const config = getConfig();
    let lastReported = 0;
    const graphicGroups = await enrichStoredQuestionGroups(
      config,
      (completed, total) => {
        if (completed === total || completed - lastReported >= 25) {
          process.stdout.write(`Graphic alt text: ${completed}/${total}\n`);
          lastReported = completed;
        }
      },
    );
    const questions = enrichStoredQuestions(config);
    process.stdout.write(
      `${JSON.stringify({ graphicGroups, questions }, null, 2)}\n`,
    );
  });

program
  .command("validate")
  .description("Run SQLite integrity, foreign-key, and downloaded-media checks")
  .action(() => {
    runMigrations();
    const result = validateDatabase(getConfig());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (
      result.integrity !== "ok" ||
      result.foreignKeyViolations.length ||
      result.missingMediaFiles.length ||
      result.checksumMismatches.length ||
      result.untrackedMediaFiles.length ||
      Object.values(result.completeness).some((issue) => issue.count > 0)
    ) {
      process.exitCode = 1;
    }
  });

program
  .command("export")
  .description("Export the normalized SQLite database to JSON")
  .option("--format <format>", "Export format (currently json)", "json")
  .option("--output <path>", "Output JSON path")
  .action((options: { format: string; output?: string }) => {
    if (options.format !== "json") {
      throw new Error(`Unsupported export format: ${options.format}`);
    }
    runMigrations();
    const target = exportDatabaseToJson(getConfig(), options.output);
    process.stdout.write(`Exported database to ${target}\n`);
  });

program
  .command("export-tests")
  .description("Export one nested JSON file per TOEIC test plus a manifest")
  .option(
    "--output-dir <path>",
    "Directory for split test files",
    "data/exports/tests",
  )
  .action((options: { outputDir: string }) => {
    runMigrations();
    const result = exportTestsToSeparateJson(getConfig(), options.outputDir);
    process.stdout.write(
      `Exported ${result.files.length} test file(s) to ${result.outputDirectory}\nManifest: ${result.manifestPath}\n`,
    );
  });

program.parseAsync().catch((error: unknown) => {
  const config = getConfig();
  const logger = createLogger(config);
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Command failed",
  );
  process.exitCode = 1;
});
