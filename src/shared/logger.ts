import pino from "pino";
import type { AppConfig } from "../config.js";

export function createLogger(config: Pick<AppConfig, "logLevel">) {
  return pino({
    level: config.logLevel,
    redact: {
      paths: [
        "accessToken",
        "refreshToken",
        "access_token",
        "refresh_token",
        "authorization",
        "Authorization",
        "apikey",
        "cookie",
        "headers.authorization",
        "headers.Authorization",
        "headers.apikey",
        "headers.cookie",
      ],
      censor: "[REDACTED]",
    },
  });
}
