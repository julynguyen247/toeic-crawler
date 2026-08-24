import type { Page, Response } from "playwright";
import type { AppConfig } from "../config.js";
import { redact, sanitizeUrl } from "../shared/redact.js";

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

export interface CapturedResponse {
  capturedAt: string;
  method: string;
  url: string;
  pathname: string;
  status: number;
  contentType: string | null;
  contentRange: string | null;
  requestBody: unknown;
  responseBody: unknown;
  bodySkippedReason: string | null;
}

async function captureResponse(
  config: AppConfig,
  response: Response,
): Promise<CapturedResponse | null> {
  const url = new URL(response.url());
  if (url.origin !== new URL(config.supabaseUrl).origin) {
    return null;
  }

  const request = response.request();
  const contentType = response.headers()["content-type"] ?? null;
  const contentLength = Number(response.headers()["content-length"] ?? "0");
  let responseBody: unknown = null;
  let bodySkippedReason: string | null = null;

  if (!contentType?.includes("application/json")) {
    bodySkippedReason = "non-json";
  } else if (contentLength > MAX_JSON_BODY_BYTES) {
    bodySkippedReason = `body-larger-than-${MAX_JSON_BODY_BYTES}`;
  } else {
    responseBody = await response.json().catch(() => null);
  }

  let requestBody: unknown = request.postDataJSON();
  if (requestBody === null) {
    requestBody = request.postData();
  }

  return redact({
    capturedAt: new Date().toISOString(),
    method: request.method(),
    url: sanitizeUrl(response.url()),
    pathname: url.pathname,
    status: response.status(),
    contentType,
    contentRange: response.headers()["content-range"] ?? null,
    requestBody,
    responseBody,
    bodySkippedReason,
  });
}

export class NetworkCapture {
  readonly #config: AppConfig;
  readonly #pending = new Set<Promise<void>>();
  readonly responses: CapturedResponse[] = [];

  constructor(config: AppConfig) {
    this.#config = config;
  }

  attach(page: Page): void {
    page.on("response", (response) => {
      const task = captureResponse(this.#config, response)
        .then((captured) => {
          if (captured) {
            this.responses.push(captured);
          }
        })
        .finally(() => this.#pending.delete(task));
      this.#pending.add(task);
    });
  }

  async settle(): Promise<void> {
    await Promise.all([...this.#pending]);
  }
}
