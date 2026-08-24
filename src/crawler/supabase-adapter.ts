import type { AppConfig } from "../config.js";
import type { SessionProvider } from "../auth/session-provider.js";
import { SourcePolicy } from "./source-policy.js";

const RETRY_DELAYS_MS = [2000, 5000, 15000] as const;

export interface SupabaseResponse<T> {
  data: T;
  status: number;
  contentRange: string | null;
}

export class SupabaseAdapter {
  readonly #config: AppConfig;
  readonly #sessions: SessionProvider;
  readonly #policy: SourcePolicy;
  #lastRequestAt = 0;

  constructor(
    config: AppConfig,
    sessions: SessionProvider,
    allowMutationsForRun = false,
  ) {
    this.#config = config;
    this.#sessions = sessions;
    this.#policy = new SourcePolicy(config, allowMutationsForRun);
  }

  async get<T>(
    path: string,
    init: Omit<RequestInit, "method"> = {},
  ): Promise<SupabaseResponse<T>> {
    return this.request<T>(path, { ...init, method: "GET" });
  }

  async rpc<T>(
    name: string,
    args: Record<string, unknown> = {},
    init: Omit<RequestInit, "method" | "body"> = {},
  ): Promise<SupabaseResponse<T>> {
    return this.request<T>(`/rest/v1/rpc/${encodeURIComponent(name)}`, {
      ...init,
      method: "POST",
      body: JSON.stringify(args),
    });
  }

  async request<T>(
    path: string,
    init: RequestInit,
  ): Promise<SupabaseResponse<T>> {
    const method = (init.method ?? "GET").toUpperCase();
    const url = new URL(path, `${this.#config.supabaseUrl}/`).toString();
    this.#policy.assertAllowed(method, url);

    for (let attempt = 0; ; attempt += 1) {
      await this.#throttle();
      const accessToken = await this.#sessions.getAccessToken();
      const headers = new Headers(init.headers);
      headers.set("apikey", this.#config.supabaseAnonKey);
      headers.set("Authorization", `Bearer ${accessToken}`);
      headers.set("Accept", "application/json");
      if (init.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }

      let response: Response;
      try {
        response = await fetch(url, { ...init, method, headers });
      } catch (error) {
        if (attempt >= RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.#sleep(RETRY_DELAYS_MS[attempt]!);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as T;
        return {
          data,
          status: response.status,
          contentRange: response.headers.get("content-range"),
        };
      }

      const body = (await response.text()).slice(0, 1000);
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `Supabase request rejected (${response.status}) for ${method} ${new URL(url).pathname}: ${body}`,
        );
      }

      const shouldRetry =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      if (!shouldRetry || attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(
          `Supabase request failed (${response.status}) for ${method} ${new URL(url).pathname}: ${body}`,
        );
      }

      const retryAfter = response.headers.get("retry-after");
      const retryAfterMs =
        retryAfter && /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : null;
      await this.#sleep(retryAfterMs ?? RETRY_DELAYS_MS[attempt]!);
    }
  }

  async #throttle(): Promise<void> {
    const elapsed = Date.now() - this.#lastRequestAt;
    const remaining = this.#config.requestDelayMs - elapsed;
    if (remaining > 0) {
      await this.#sleep(remaining);
    }
    this.#lastRequestAt = Date.now();
  }

  async #sleep(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
