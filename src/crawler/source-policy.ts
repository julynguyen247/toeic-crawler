import type { AppConfig } from "../config.js";
import type { BrowserContext } from "playwright";
import { redact, sanitizeUrl } from "../shared/redact.js";

export class SourcePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePolicyError";
  }
}

export class SourcePolicy {
  readonly #config: AppConfig;
  readonly #allowMutationsForRun: boolean;

  constructor(config: AppConfig, allowMutationsForRun = false) {
    this.#config = config;
    this.#allowMutationsForRun = allowMutationsForRun;
  }

  assertAllowed(methodInput: string, urlInput: string): void {
    const method = methodInput.toUpperCase();
    const url = new URL(urlInput, this.#config.supabaseUrl);
    if (url.origin !== new URL(this.#config.supabaseUrl).origin) {
      throw new SourcePolicyError(
        `Refusing request outside configured Supabase origin: ${url.origin}`,
      );
    }

    if (method === "OPTIONS") {
      return;
    }

    const rule = this.#config.crawler.allowedRequests.find(
      (candidate) =>
        candidate.method === method &&
        url.pathname.startsWith(candidate.pathPrefix),
    );
    if (!rule) {
      throw new SourcePolicyError(
        `${method} ${url.pathname} is not in allowedRequests.`,
      );
    }

    if (method === "GET" || method === "HEAD") {
      return;
    }

    if (
      method === "POST" &&
      this.#config.crawler.readOnlyPostEndpoints.some(
        (endpoint) => url.pathname === endpoint,
      )
    ) {
      return;
    }

    if (
      !this.#config.crawler.allowSourceMutations ||
      !this.#allowMutationsForRun
    ) {
      throw new SourcePolicyError(
        `${method} ${url.pathname} may mutate source state. Both allowSourceMutations and --allow-source-mutations are required.`,
      );
    }
  }
}

export interface BlockedSourceRequest {
  method: string;
  url: string;
  pathname: string;
  postData: unknown;
  reason: string;
}

export async function installBrowserSourcePolicy(
  context: BrowserContext,
  config: AppConfig,
  allowMutationsForRun = false,
): Promise<BlockedSourceRequest[]> {
  const policy = new SourcePolicy(config, allowMutationsForRun);
  const blocked: BlockedSourceRequest[] = [];
  await context.route(`${config.supabaseUrl}/**`, async (route) => {
    const request = route.request();
    try {
      policy.assertAllowed(request.method(), request.url());
      await route.continue();
    } catch (error) {
      let postData: unknown = request.postData();
      try {
        postData = request.postDataJSON();
      } catch {
        // Keep the raw post body; redact() is applied below.
      }
      const url = new URL(request.url());
      blocked.push(
        redact({
          method: request.method(),
          url: sanitizeUrl(request.url()),
          pathname: url.pathname,
          postData,
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      await route.abort("blockedbyclient");
    }
  });
  return blocked;
}
