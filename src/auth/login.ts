import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createClient, type Session } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";
import type { AppConfig } from "../config.js";
import { ensureDirectory, ensureParent } from "../shared/files.js";
import { saveSession, toStoredSession } from "./session-store.js";

const AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const CHROME_EXECUTABLE = "/usr/bin/google-chrome-stable";

function findSession(
  value: unknown,
  seen = new Set<unknown>(),
): Session | null {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return null;
  }
  seen.add(value);
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.access_token === "string" &&
    typeof candidate.refresh_token === "string" &&
    candidate.user &&
    typeof candidate.user === "object"
  ) {
    return candidate as unknown as Session;
  }
  for (const nested of Object.values(candidate)) {
    const session = findSession(nested, seen);
    if (session) {
      return session;
    }
  }
  return null;
}

export async function extractSessionFromPage(
  page: Page,
  projectRef: string,
): Promise<Session | null> {
  const values = await page.evaluate((ref) => {
    const preferredKey = `sb-${ref}-auth-token`;
    const entries = Object.entries(window.localStorage);
    return entries
      .filter(
        ([key]) =>
          key === preferredKey ||
          (key.startsWith("sb-") && key.endsWith("-auth-token")),
      )
      .map(([key, value]) => ({ key, value }));
  }, projectRef);
  for (const entry of values) {
    try {
      const session = findSession(JSON.parse(entry.value));
      if (session) {
        return session;
      }
    } catch {
      // Ignore unrelated or partially written localStorage values.
    }
  }
  return null;
}

async function verifySession(
  config: AppConfig,
  session: Session,
): Promise<void> {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const { data, error } = await client.auth.getUser(session.access_token);
  if (error || !data.user) {
    throw new Error(
      `Google login completed, but Supabase rejected the session: ${error?.message ?? "no user"}`,
    );
  }
  if (data.user.id !== session.user.id) {
    throw new Error("Supabase session user mismatch.");
  }
}

async function waitForDebugPort(
  profileDirectory: string,
  chromeProcess: ChildProcess,
): Promise<number> {
  const portFile = path.join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && chromeProcess.exitCode === null) {
    try {
      const [portText] = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
      const port = Number(portText);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch {
      // Chrome has not created DevToolsActivePort yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome did not expose a local debugging port.");
}

async function waitForProcessExit(processHandle: ChildProcess): Promise<void> {
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  while (Date.now() < deadline && processHandle.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (processHandle.exitCode === null) {
    processHandle.kill("SIGTERM");
    throw new Error(
      "Timed out waiting for the normal Chrome login window to close.",
    );
  }
}

async function waitForProcessExitWithin(
  processHandle: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processHandle.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function runInteractiveLogin(config: AppConfig): Promise<void> {
  ensureDirectory(path.dirname(config.authSessionPath), 0o700);
  ensureParent(config.authStatePath, 0o700);
  if (!fs.existsSync(CHROME_EXECUTABLE)) {
    throw new Error(`Google Chrome was not found at ${CHROME_EXECUTABLE}.`);
  }

  const profileDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "dautoeic-auth-"),
  );
  let chromeProcess: ChildProcess | null = null;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | null =
    null;

  try {
    // Stage 1 deliberately has no Playwright/CDP connection. Google sees a normal Chrome session.
    chromeProcess = spawn(
      CHROME_EXECUTABLE,
      [
        `--user-data-dir=${profileDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
        `${config.sourceBaseUrl}/login`,
      ],
      { stdio: "ignore" },
    );

    process.stdout.write(
      "Chrome thường đã mở và không bị automation điều khiển. Hãy đăng nhập Google; khi đã quay về Đậu TOEIC, đóng toàn bộ cửa sổ Chrome này để tool lưu session.\n",
    );
    await waitForProcessExit(chromeProcess);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Stage 2 reopens the completed temporary profile locally and extracts only the site session.
    chromeProcess = spawn(
      CHROME_EXECUTABLE,
      [
        `--user-data-dir=${profileDirectory}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        config.sourceBaseUrl,
      ],
      { stdio: "ignore" },
    );
    const port = await waitForDebugPort(profileDirectory, chromeProcess);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) {
      throw new Error(
        "Could not access the Chrome browser context after OAuth.",
      );
    }
    const page = context
      .pages()
      .find((candidate) => candidate.url().startsWith(config.sourceBaseUrl));
    if (!page) {
      throw new Error(
        "OAuth returned, but the dautoeic.com tab could not be found.",
      );
    }
    const session = await extractSessionFromPage(
      page,
      config.supabaseProjectRef,
    );
    if (!session) {
      throw new Error(
        "OAuth returned, but no Supabase session was found in website storage.",
      );
    }

    await verifySession(config, session);
    await context.storageState({ path: config.authStatePath, indexedDB: true });
    fs.chmodSync(config.authStatePath, 0o600);
    saveSession(config.authSessionPath, toStoredSession(session));
    process.stdout.write(
      `Đăng nhập thành công cho ${session.user.email ?? session.user.id}.\n`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    if (chromeProcess?.exitCode === null) {
      chromeProcess.kill("SIGTERM");
      await waitForProcessExitWithin(chromeProcess, 5000);
    }
    try {
      fs.rmSync(profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    } catch (error) {
      process.stderr.write(
        `Cảnh báo: chưa dọn được profile Chrome tạm ${profileDirectory}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
