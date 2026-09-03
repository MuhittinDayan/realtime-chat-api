import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";
import {
  NotificationCleanupService,
  NotificationCleanupWorker,
  type NotificationCleanupLogger,
  type NotificationCleanupRunner,
} from "./notification-cleanup.worker.js";

const NOW = new Date("2030-02-01T00:00:00.000Z");
const RETENTION_MS = 720 * 60 * 60 * 1_000;

function cleanupLogger() {
  const debug = vi.fn<NotificationCleanupLogger["debug"]>();
  const error = vi.fn<NotificationCleanupLogger["error"]>();

  return { debug, error };
}

describe("notification cleanup", () => {
  it("bulk-deletes only read notifications older than retention", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 4 });
    const service = new NotificationCleanupService(
      { notification: { deleteMany } } as unknown as PrismaClient,
      RETENTION_MS,
      () => NOW,
    );

    await expect(service.runOnce()).resolves.toEqual({
      deletedNotifications: 4,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        readAt: {
          not: null,
          lt: new Date("2030-01-02T00:00:00.000Z"),
        },
      },
    });
  });

  it("prevents overlap, logs failures and lets stop await an active run", async () => {
    let resolveRun!: (value: { deletedNotifications: number }) => void;
    const activeRun = new Promise<{ deletedNotifications: number }>(
      (resolve) => {
        resolveRun = resolve;
      },
    );
    const runner: NotificationCleanupRunner = {
      runOnce: vi.fn().mockReturnValue(activeRun),
    };
    const workerLogger = cleanupLogger();
    const worker = new NotificationCleanupWorker(
      runner,
      3_600_000,
      workerLogger,
    );

    const first = worker.tick();
    const overlapping = worker.tick();
    const stopping = worker.stop();
    expect(runner.runOnce).toHaveBeenCalledTimes(1);

    resolveRun({ deletedNotifications: 2 });
    await Promise.all([first, overlapping, stopping]);
    expect(workerLogger.debug).toHaveBeenCalledWith(
      { deletedNotifications: 2 },
      "Notification cleanup completed",
    );

    const failure = new Error("database unavailable");
    const failingRunner: NotificationCleanupRunner = {
      runOnce: vi.fn().mockRejectedValue(failure),
    };
    const failureLogger = cleanupLogger();
    const failingWorker = new NotificationCleanupWorker(
      failingRunner,
      3_600_000,
      failureLogger,
    );
    await expect(failingWorker.tick()).resolves.toBeUndefined();
    expect(failureLogger.error).toHaveBeenCalledWith(
      { err: failure },
      "Notification cleanup failed",
    );
  });
});
