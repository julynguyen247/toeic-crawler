import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadSession, saveSession } from "../src/auth/session-store.js";
import { temporaryConfig } from "./helpers.js";

describe("session store", () => {
  it("writes a parseable 0600 session atomically", () => {
    const config = temporaryConfig();
    const session = {
      accessToken: "access-token-with-enough-characters",
      refreshToken: "refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      tokenType: "bearer",
      user: { id: "user-1", email: "user@example.com" },
      savedAt: new Date().toISOString(),
    };
    saveSession(config.authSessionPath, session);

    expect(loadSession(config.authSessionPath)).toEqual(session);
    expect(fs.statSync(config.authSessionPath).mode & 0o777).toBe(0o600);
    expect(
      fs.statSync(new URL(".", `file://${config.authSessionPath}`).pathname)
        .mode & 0o777,
    ).toBe(0o700);
  });
});
