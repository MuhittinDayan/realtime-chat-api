import { createServer } from "node:http";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { createSocketServer } from "./realtime/server/index.js";
import { logger } from "./shared/logging/logger.js";

const httpServer = createServer(app);
const socketServer = createSocketServer(httpServer);

type ShutdownReason = NodeJS.Signals | "HTTP_SERVER_ERROR";

let shutdownPromise: Promise<void> | undefined;

function closeSocketServer(): Promise<void> {
  return new Promise((resolve) => {
    socketServer.close(() => resolve());
  });
}

async function performShutdown(
  reason: ShutdownReason,
  exitCode: number,
): Promise<void> {
  logger.info({ reason }, "Graceful shutdown started");

  const forceShutdownTimer = setTimeout(() => {
    logger.fatal(
      { reason, timeoutMs: env.SHUTDOWN_TIMEOUT_MS },
      "Graceful shutdown timed out",
    );
    httpServer.closeAllConnections();
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);

  forceShutdownTimer.unref();

  try {
    await closeSocketServer();
    await prisma.$disconnect();
    process.exitCode = exitCode;
    logger.info({ reason }, "Graceful shutdown completed");
  } catch (error: unknown) {
    process.exitCode = 1;
    logger.error({ err: error, reason }, "Graceful shutdown failed");
  } finally {
    clearTimeout(forceShutdownTimer);
  }
}

function shutdown(reason: ShutdownReason, exitCode = 0): Promise<void> {
  shutdownPromise ??= performShutdown(reason, exitCode);

  return shutdownPromise;
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

httpServer.once("error", (error) => {
  logger.fatal({ err: error }, "HTTP server error");
  void shutdown("HTTP_SERVER_ERROR", 1);
});

httpServer.listen(env.PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: env.PORT,
    },
    "Chat API listening",
  );
});
