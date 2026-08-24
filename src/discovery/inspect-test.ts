import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
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

export interface InspectTestOptions {
  testTitle: string;
  headed: boolean;
}

export interface InspectTestResult {
  pageUrl: string;
  capturedResponses: number;
  blockedRequests: number;
  endpointSummary: Array<{ method: string; pathname: string; status: number }>;
  reportPath: string;
}

export async function inspectTest(
  config: AppConfig,
  options: InspectTestOptions,
): Promise<InspectTestResult> {
  const sessions = new SessionProvider(config);
  const session = await sessions.initialize();
  const { runId, handle } = startRun(
    config,
    `inspect:${options.testTitle}`,
    true,
  );
  const errors: unknown[] = [];
  let browser;

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: !options.headed,
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
    const heading = page.getByRole("heading", {
      name: options.testTitle,
      exact: true,
    });
    await heading.waitFor({ timeout: 20_000 });

    const card = heading.locator(
      "xpath=ancestor::div[.//button[normalize-space()='Luyện tập'] or .//button[normalize-space()='Thi thử']][1]",
    );
    const practiceButton = card.getByRole("button", {
      name: "Luyện tập",
      exact: true,
    });
    await practiceButton.click();

    await page
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForTimeout(4_000);
    const loginDialog = page
      .getByRole("dialog")
      .getByText(/Lưu tiến độ học tập/i);
    if (await loginDialog.isVisible().catch(() => false)) {
      throw new Error(
        "Website did not recognize the saved session. Run `npm run auth` again.",
      );
    }

    await capture.settle();
    const endpointSummary = capture.responses.map(
      ({ method, pathname, status }) => ({ method, pathname, status }),
    );
    const payload = {
      runId,
      testTitle: options.testTitle,
      pageUrl: page.url(),
      pageTitle: await page.title(),
      endpointSummary,
      responses: capture.responses,
      blockedRequests,
    };
    const snapshot = saveRawSnapshot(
      config,
      runId,
      "test-inspection",
      options.testTitle,
      payload,
    );
    recordSnapshot(handle, {
      runId,
      entityType: "test-inspection",
      entitySourceId: options.testTitle,
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
        mode: "inspect",
        readOnly: true,
        sourceMutations: [],
        testTitle: options.testTitle,
        pageUrl: page.url(),
        capturedResponses: capture.responses.length,
        blockedRequests,
        endpointSummary,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );

    const browserSession = await extractSessionFromPage(
      page,
      config.supabaseProjectRef,
    ).catch(() => null);
    if (browserSession) {
      saveSession(config.authSessionPath, toStoredSession(browserSession));
    }
    await context.storageState({ path: config.authStatePath, indexedDB: true });
    fs.chmodSync(config.authStatePath, 0o600);
    finishRun(handle, runId, "complete");
    return {
      pageUrl: page.url(),
      capturedResponses: capture.responses.length,
      blockedRequests: blockedRequests.length,
      endpointSummary,
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
