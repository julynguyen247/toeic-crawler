import fs from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import type { AppConfig } from "../config.js";
import { extractSessionFromPage } from "../auth/login.js";
import { installBrowserSession } from "../auth/browser-session.js";
import { saveSession, toStoredSession } from "../auth/session-store.js";
import { SessionProvider } from "../auth/session-provider.js";
import { installBrowserSourcePolicy } from "../crawler/source-policy.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";
import { NetworkCapture } from "./capture-network.js";

export interface CatalogResult {
  collections: string[];
  tests: Array<{ title: string; cardText: string }>;
  capturedResponses: number;
  blockedRequests: number;
  reportPath: string;
}

async function saveUpdatedBrowserSession(
  context: BrowserContext,
  config: AppConfig,
): Promise<void> {
  await context.storageState({ path: config.authStatePath, indexedDB: true });
  fs.chmodSync(config.authStatePath, 0o600);
  for (const page of context.pages()) {
    if (!page.url().startsWith(config.sourceBaseUrl)) {
      continue;
    }
    const session = await extractSessionFromPage(
      page,
      config.supabaseProjectRef,
    ).catch(() => null);
    if (session) {
      saveSession(config.authSessionPath, toStoredSession(session));
      return;
    }
  }
}

export async function discoverCatalog(
  config: AppConfig,
): Promise<CatalogResult> {
  const sessions = new SessionProvider(config);
  const session = await sessions.initialize();
  const { runId, handle } = startRun(config, "catalog", true);
  const errors: unknown[] = [];
  let browser;

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: config.headless,
    });
    const context = await browser.newContext({
      storageState: config.authStatePath,
    });
    await installBrowserSession(context, config, session);
    const blockedRequests = await installBrowserSourcePolicy(context, config);
    const page = await context.newPage();
    const capture = new NetworkCapture(config);
    capture.attach(page);

    await page.goto(`${config.sourceBaseUrl}/mock-test`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);
    await page
      .getByRole("heading", { name: /Luyện đề thi TOEIC/i })
      .waitFor({ timeout: 20_000 });

    const collections = await page
      .locator("button")
      .evaluateAll((buttons) =>
        buttons
          .map((button) => (button.textContent ?? "").trim())
          .filter((text) => /\(\d+\)$/.test(text)),
      );
    const tests = await page.locator("h3").evaluateAll((headings) =>
      headings
        .filter((heading) =>
          /^Test\s+\d+/i.test((heading.textContent ?? "").trim()),
        )
        .map((heading) => ({
          title: (heading.textContent ?? "").trim(),
          cardText: (heading.parentElement?.parentElement?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
        })),
    );

    await capture.settle();
    const payload = {
      runId,
      sourceUrl: page.url(),
      collections,
      tests,
      responses: capture.responses,
      blockedRequests,
    };
    const snapshot = saveRawSnapshot(
      config,
      runId,
      "catalog",
      "mock-test",
      payload,
    );
    recordSnapshot(handle, {
      runId,
      entityType: "catalog",
      entitySourceId: "mock-test",
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
        mode: "catalog",
        readOnly: true,
        sourceMutations: [],
        collections,
        tests,
        capturedResponses: capture.responses.length,
        blockedRequests,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    await saveUpdatedBrowserSession(context, config);
    return {
      collections,
      tests,
      capturedResponses: capture.responses.length,
      blockedRequests: blockedRequests.length,
      reportPath,
    };
  } catch (error) {
    errors.push({
      message: error instanceof Error ? error.message : String(error),
    });
    finishRun(handle, runId, "failed", errors);
    throw error;
  } finally {
    await browser?.close();
    handle.sqlite.close();
  }
}
