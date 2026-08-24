import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config.js";
import {
  loadSession,
  saveSession,
  toStoredSession,
  type StoredSession,
} from "./session-store.js";

const REFRESH_WINDOW_SECONDS = 60;

export class SessionProvider {
  readonly #config: AppConfig;
  readonly #client: SupabaseClient;
  #session: StoredSession | null = null;

  constructor(config: AppConfig) {
    this.#config = config;
    this.#client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    });
  }

  async initialize(): Promise<StoredSession> {
    const stored = loadSession(this.#config.authSessionPath);
    const { data, error } = await this.#client.auth.setSession({
      access_token: stored.accessToken,
      refresh_token: stored.refreshToken,
    });
    if (error || !data.session) {
      throw new Error(
        `Could not restore Supabase session: ${error?.message ?? "empty session"}`,
      );
    }

    this.#session = toStoredSession(data.session);
    await this.#refreshIfNeeded();
    await this.#verifyUser();
    saveSession(this.#config.authSessionPath, this.#requireSession());
    return this.#requireSession();
  }

  async getAccessToken(): Promise<string> {
    if (!this.#session) {
      await this.initialize();
    } else {
      await this.#refreshIfNeeded();
    }
    return this.#requireSession().accessToken;
  }

  get userId(): string {
    return this.#requireSession().user.id;
  }

  async #refreshIfNeeded(): Promise<void> {
    const session = this.#requireSession();
    const now = Math.floor(Date.now() / 1000);
    if (session.expiresAt - now > REFRESH_WINDOW_SECONDS) {
      return;
    }

    const { data, error } = await this.#client.auth.refreshSession({
      refresh_token: session.refreshToken,
    });
    if (error || !data.session) {
      throw new Error(
        `Supabase session refresh failed: ${error?.message ?? "empty session"}`,
      );
    }
    this.#session = toStoredSession(data.session);
    saveSession(this.#config.authSessionPath, this.#session);
  }

  async #verifyUser(): Promise<void> {
    const { data, error } = await this.#client.auth.getUser(
      this.#requireSession().accessToken,
    );
    if (error || !data.user) {
      throw new Error(
        `Supabase user verification failed: ${error?.message ?? "no user"}`,
      );
    }
    if (data.user.id !== this.#requireSession().user.id) {
      throw new Error("Saved Supabase session belongs to a different user.");
    }
  }

  #requireSession(): StoredSession {
    if (!this.#session) {
      throw new Error("SessionProvider has not been initialized.");
    }
    return this.#session;
  }
}
