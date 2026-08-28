import { describe, expect, it, vi } from "vitest";

import {
  AvatarCleanupWorker,
  type AvatarCleanupRunner,
  type CleanupLogger,
} from "./avatar-cleanup.worker.js";

function deferred(): {
  promise: Promise<{ inspected: number; deletedAssets: number; clearedIncomingObjects: number }>;
  resolve: () => void;
} {
  let resolvePromise!: (value: {
    inspected: number;
    deletedAssets: number;
    clearedIncomingObjects: number;
  }) => void;
  const promise = new Promise<{
    inspected: number;
    deletedAssets: number;
    clearedIncomingObjects: number;
  }>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve: () =>
      resolvePromise({
        inspected: 1,
        deletedAssets: 1,
        clearedIncomingObjects: 1,
      }),
  };
}

function logger(): CleanupLogger & {
  debug: ReturnType<typeof vi.fn<(context: object, message: string) => void>>;
  error: ReturnType<typeof vi.fn<(context: object, message: string) => void>>;
} {
  return {
    debug: vi.fn<(context: object, message: string) => void>(),
    error: vi.fn<(context: object, message: string) => void>(),
  };
}

describe("avatar cleanup worker", () => {
  it("prevents overlapping runs and lets shutdown await the active run", async () => {
    const run = deferred();
    const runner: AvatarCleanupRunner = { runOnce: vi.fn(() => run.promise) };
    const cleanupLogger = logger();
    const worker = new AvatarCleanupWorker(runner, 900_000, cleanupLogger);

    const first = worker.tick();
    const overlapping = worker.tick();
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(runner.runOnce).toHaveBeenCalledTimes(1);

    run.resolve();
    await Promise.all([first, overlapping, stopping]);

    expect(stopped).toBe(true);
    expect(cleanupLogger.debug).toHaveBeenCalledWith(
      { inspected: 1, deletedAssets: 1, clearedIncomingObjects: 1 },
      "Avatar cleanup completed",
    );
  });

  it("logs a failed run without rejecting the timer callback", async () => {
    const failure = new Error("storage offline");
    const runner: AvatarCleanupRunner = {
      runOnce: vi.fn().mockRejectedValue(failure),
    };
    const cleanupLogger = logger();
    const worker = new AvatarCleanupWorker(runner, 900_000, cleanupLogger);

    await expect(worker.tick()).resolves.toBeUndefined();
    expect(cleanupLogger.error).toHaveBeenCalledWith(
      { err: failure },
      "Avatar cleanup failed",
    );
  });

  it("can be started and stopped repeatedly", async () => {
    vi.useFakeTimers();
    const runner: AvatarCleanupRunner = {
      runOnce: vi.fn().mockResolvedValue({
        inspected: 0,
        deletedAssets: 0,
        clearedIncomingObjects: 0,
      }),
    };
    const worker = new AvatarCleanupWorker(runner, 100, logger());

    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(100);
    await worker.stop();
    await worker.stop();

    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
