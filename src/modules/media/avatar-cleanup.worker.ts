import {
  objectStorage,
  storageBuckets,
  storageSettings,
} from "../../infrastructure/storage/index.js";
import { logger } from "../../shared/logging/logger.js";
import { AvatarCleanupService } from "./avatar-cleanup.service.js";
import { PrismaAvatarRepository } from "./avatar.repository.js";

export interface CleanupLogger {
  debug(context: object, message: string): void;
  error(context: object, message: string): void;
}

export interface AvatarCleanupRunner {
  runOnce(): ReturnType<AvatarCleanupService["runOnce"]>;
}

export class AvatarCleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private activeRun: Promise<void> | undefined;

  constructor(
    private readonly service: AvatarCleanupRunner,
    private readonly intervalMs: number,
    private readonly cleanupLogger: CleanupLogger,
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
      const result = await this.service.runOnce();
      this.cleanupLogger.debug(result, "Avatar cleanup completed");
    } catch (error: unknown) {
      this.cleanupLogger.error({ err: error }, "Avatar cleanup failed");
    }
  }
}

const avatarCleanupService = new AvatarCleanupService(
  new PrismaAvatarRepository(),
  objectStorage,
  {
    avatarBucket: storageBuckets.avatar,
    staleUploadAgeMs: storageSettings.staleUploadAgeMs,
  },
);

export const avatarCleanupWorker = new AvatarCleanupWorker(
  avatarCleanupService,
  storageSettings.cleanupIntervalMs,
  logger,
);
