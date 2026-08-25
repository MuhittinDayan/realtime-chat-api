import pino from "pino";

import { env } from "../../config/env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "chat-api",
    environment: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.password",
      "req.body.passwordHash",
      "req.body.accessToken",
      "req.body.refreshToken",
      "res.headers[\"set-cookie\"]",
      "err.body",
      "password",
      "passwordHash",
      "accessToken",
      "refreshToken",
      "refreshTokenHash",
      "token",
    ],
    censor: "[REDACTED]",
  },
});
