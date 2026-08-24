import type { BrowserContext } from "playwright";
import type { AppConfig } from "../config.js";
import type { StoredSession } from "./session-store.js";

export async function installBrowserSession(
  context: BrowserContext,
  config: AppConfig,
  session: StoredSession,
): Promise<void> {
  const storageKey = `sb-${config.supabaseProjectRef}-auth-token`;
  const expiresIn = Math.max(
    0,
    session.expiresAt - Math.floor(Date.now() / 1000),
  );
  const value = JSON.stringify({
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_at: session.expiresAt,
    expires_in: expiresIn,
    token_type: session.tokenType,
    user: session.user,
  });

  await context.addInitScript(
    ({ expectedOrigin, key, serializedSession }) => {
      if (window.location.origin === expectedOrigin) {
        window.localStorage.setItem(key, serializedSession);
      }
    },
    {
      expectedOrigin: new URL(config.sourceBaseUrl).origin,
      key: storageKey,
      serializedSession: value,
    },
  );
}
