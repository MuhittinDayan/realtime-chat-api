import type { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { logger } from "../../shared/logging/logger.js";

const HOUR_MS = 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = HOUR_MS;

export interface NotificationCleanupLogger {
  debug(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface NotificationCleanupRunner {
  runOnce(): Promise<{ deletedNotifications: number }>;
}

export class NotificationCleanupService implements NotificationCleanupRunner {
  constructor(
    private readonly client: PrismaClient,
    private readonly retentionMs: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<{ deletedNotifications: number }> {
    const readBefore = new Date(this.now().getTime() - this.retentionMs);
    const result = await this.client.notification.deleteMany({
      where: { readAt: { not: null, lt: readBefore } },
    });

    return { deletedNotifications: result.count };
  }
}

export class NotificationCleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;

  constructor(
    private readonly runner: NotificationCleanupRunner,
    private readonly intervalMs: number,
    private readonly cleanupLogger: NotificationCleanupLogger,
  ) {}

  start(): void {
    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    await this.activeRun;
  }

  async tick(): Promise<void> {
    if (this.activeRun !== undefined) {
      return this.activeRun;
    }

    this.activeRun = this.execute();

    try {
      await this.activeRun;
    } finally {
      this.activeRun = undefined;
    }
  }

  private async execute(): Promise<void> {
    try {
      const result = await this.runner.runOnce();
      this.cleanupLogger.debug(result, "Notification cleanup completed");
    } catch (error: unknown) {
      this.cleanupLogger.error({ err: error }, "Notification cleanup failed");
    }
  }
}

const notificationCleanupService = new NotificationCleanupService(
  prisma,
  env.NOTIFICATION_READ_RETENTION_HOURS * HOUR_MS,
);

export const notificationCleanupWorker = new NotificationCleanupWorker(
  notificationCleanupService,
  CLEANUP_INTERVAL_MS,
  logger,
);
