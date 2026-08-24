import path from "node:path";
import { chromium } from "playwright";
import { installBrowserSession } from "../auth/browser-session.js";
import { SessionProvider } from "../auth/session-provider.js";
import type { AppConfig } from "../config.js";
import { installBrowserSourcePolicy } from "../crawler/source-policy.js";
import { ensureDirectory, writeJsonAtomic } from "../shared/files.js";
import { sanitizeUrl } from "../shared/redact.js";
import { saveRawSnapshot } from "../storage/raw-snapshot.js";
import {
  finishRun,
  recordSnapshot,
  startRun,
} from "../storage/run-repository.js";
import { NetworkCapture } from "./capture-network.js";

const DEFAULT_ROUTES = [
  "/hub",
  "/grammar",
  "/listening",
  "/reading",
  "/vocabulary",
  "/mock-test",
  "/video",
  "/blog",
];

interface RouteDiscovery {
  requestedRoute: string;
  finalUrl: string;
  title: string;
  headings: string[];
  links: Array<{ text: string; href: string }>;
  supabaseResponses: number;
  blockedRequests: number;
  error: string | null;
}

export interface SiteDiscoveryResult {
  runId: string;
  routes: RouteDiscovery[];
  endpointSummary: Array<{
    method: string;
    pathname: string;
    statuses: number[];
    count: number;
  }>;
  blockedEndpointSummary: Array<{
    method: string;
    pathname: string;
    count: number;
  }>;
  reportPath: string;
}

export async function discoverSite(
  config: AppConfig,
): Promise<SiteDiscoveryResult> {
  const sessions = new SessionProvider(config);
  const session = await sessions.initialize();
  const { runId, handle } = startRun(config, "site-discovery", true);
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
    const blocked = await installBrowserSourcePolicy(context, config);
    const page = await context.newPage();
    const capture = new NetworkCapture(config);
    capture.attach(page);
    const routes: RouteDiscovery[] = [];

    for (const route of DEFAULT_ROUTES) {
      const responseStart = capture.responses.length;
      const blockedStart = blocked.length;
      let error: string | null = null;
      try {
        await page.goto(`${config.sourceBaseUrl}${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        await page
          .waitForLoadState("networkidle", { timeout: 12_000 })
          .catch(() => undefined);
        await page.waitForTimeout(750);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      await capture.settle();
      const headings = await page
        .locator("h1, h2, h3")
        .evaluateAll((elements) =>
          elements
            .map((element) =>
              (element.textContent ?? "").replace(/\s+/g, " ").trim(),
            )
            .filter(Boolean)
            .slice(0, 100),
        )
        .catch(() => []);
      const links = await page
        .locator("a[href]")
        .evaluateAll((elements) =>
          elements
            .map((element) => ({
              text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
              href: (element as HTMLAnchorElement).href,
            }))
            .filter((link) => link.href.startsWith(window.location.origin))
            .slice(0, 250),
        )
        .catch(() => []);
      routes.push({
        requestedRoute: route,
        finalUrl: sanitizeUrl(page.url()),
        title: await page.title().catch(() => ""),
        headings,
        links: links.map((link) => ({
          text: link.text,
          href: sanitizeUrl(link.href),
        })),
        supabaseResponses: capture.responses.length - responseStart,
        blockedRequests: blocked.length - blockedStart,
        error,
      });
    }

    const endpointMap = new Map<
      string,
      { method: string; pathname: string; statuses: Set<number>; count: number }
    >();
    for (const response of capture.responses) {
      const key = `${response.method} ${response.pathname}`;
      const current = endpointMap.get(key) ?? {
        method: response.method,
        pathname: response.pathname,
        statuses: new Set<number>(),
        count: 0,
      };
      current.statuses.add(response.status);
      current.count += 1;
      endpointMap.set(key, current);
    }
    const endpointSummary = [...endpointMap.values()]
      .map((entry) => ({
        method: entry.method,
        pathname: entry.pathname,
        statuses: [...entry.statuses].sort((a, b) => a - b),
        count: entry.count,
      }))
      .sort((a, b) => a.pathname.localeCompare(b.pathname));

    const blockedMap = new Map<
      string,
      { method: string; pathname: string; count: number }
    >();
    for (const request of blocked) {
      const key = `${request.method} ${request.pathname}`;
      const current = blockedMap.get(key) ?? {
        method: request.method,
        pathname: request.pathname,
        count: 0,
      };
      current.count += 1;
      blockedMap.set(key, current);
    }
    const blockedEndpointSummary = [...blockedMap.values()].sort((a, b) =>
      a.pathname.localeCompare(b.pathname),
    );

    const snapshot = saveRawSnapshot(config, runId, "site-discovery", "all", {
      routes,
      responses: capture.responses,
      blockedRequests: blocked,
    });
    recordSnapshot(handle, {
      runId,
      entityType: "site-discovery",
      entitySourceId: "all",
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
        mode: "site-discovery",
        readOnly: true,
        sourceMutations: [],
        routes,
        endpointSummary,
        blockedEndpointSummary,
        rawSnapshot: snapshot.relativePath,
      },
      0o644,
    );
    finishRun(handle, runId, "complete");
    return {
      runId,
      routes,
      endpointSummary,
      blockedEndpointSummary,
      reportPath,
    };
  } catch (error) {
    finishRun(handle, runId, "failed", [
      { message: error instanceof Error ? error.message : String(error) },
    ]);
    throw error;
  } finally {
    await browser?.close();
    handle.sqlite.close();
  }
}
