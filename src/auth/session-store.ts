import fs from "node:fs";
import path from "node:path";
import type { Session } from "@supabase/supabase-js";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import {
  ensureDirectory,
  removeFileIfPresent,
  writeJsonAtomic,
} from "../shared/files.js";

const storedSessionSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: z.string().min(10),
  expiresAt: z.number().int().positive(),
  tokenType: z.string().default("bearer"),
  user: z
    .object({
      id: z.string().min(1),
      email: z.string().nullable(),
    })
    .passthrough(),
  savedAt: z.string(),
});

export type StoredSession = z.infer<typeof storedSessionSchema>;

export function toStoredSession(session: Session): StoredSession {
  const expiresAt =
    session.expires_at ??
    Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);
  return storedSessionSchema.parse({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt,
    tokenType: session.token_type,
    user: {
      ...session.user,
      id: session.user.id,
      email: session.user.email ?? null,
    },
    savedAt: new Date().toISOString(),
  });
}

export function saveSession(filePath: string, session: StoredSession): void {
  writeJsonAtomic(filePath, storedSessionSchema.parse(session), 0o600);
}

export function loadSession(filePath: string): StoredSession {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No saved session found at ${filePath}. Run \`npm run auth\` first.`,
      );
    }
    throw error;
  }
  return storedSessionSchema.parse(JSON.parse(text));
}

export function clearSavedAuth(
  config: Pick<AppConfig, "authSessionPath" | "authStatePath">,
): string[] {
  const removed = [config.authSessionPath, config.authStatePath].filter(
    removeFileIfPresent,
  );
  const authDirectory = path.dirname(config.authSessionPath);
  if (fs.existsSync(authDirectory)) {
    fs.chmodSync(authDirectory, 0o700);
  } else {
    ensureDirectory(authDirectory, 0o700);
  }
  return removed;
}
