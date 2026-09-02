import { createConnection, type Socket } from "node:net";

const INSTREAM_COMMAND = Buffer.from("zINSTREAM\0", "ascii");
const STREAM_TERMINATOR = Buffer.alloc(4);
const CHUNK_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 8 * 1_024;

export interface AttachmentMalwareScanResult {
  status: "CLEAN" | "FOUND";
  signature?: string;
}

export interface AttachmentMalwareScanner {
  scan(body: Uint8Array): Promise<AttachmentMalwareScanResult>;
}

export interface ClamAvScannerConfig {
  host: string;
  port: number;
  timeoutMs: number;
  maxConcurrentScans: number;
  streamMaxLengthBytes: number;
}

export class ClamAvUnavailableError extends Error {
  override readonly name = "ClamAvUnavailableError";

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

interface SemaphoreWaiter {
  resolve(release: () => void): void;
  reject(error: ClamAvUnavailableError): void;
  timer: NodeJS.Timeout;
}

class ScanSemaphore {
  private active = 0;
  private readonly waiters: SemaphoreWaiter[] = [];

  constructor(private readonly maximum: number) {}

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);

          if (index >= 0) {
            this.waiters.splice(index, 1);
          }

          reject(new ClamAvUnavailableError("ClamAV scan queue timed out"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  private createRelease(): () => void {
    let released = false;

    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();

      if (waiter === undefined) {
        this.active -= 1;
        return;
      }

      clearTimeout(waiter.timer);
      waiter.resolve(this.createRelease());
    };
  }
}

export class ClamAvAttachmentScanner implements AttachmentMalwareScanner {
  private readonly semaphore: ScanSemaphore;

  constructor(private readonly config: ClamAvScannerConfig) {
    if (
      !Number.isInteger(config.port) ||
      config.port < 1 ||
      config.port > 65_535 ||
      !Number.isInteger(config.timeoutMs) ||
      config.timeoutMs < 1 ||
      !Number.isInteger(config.maxConcurrentScans) ||
      config.maxConcurrentScans < 1 ||
      !Number.isInteger(config.streamMaxLengthBytes) ||
      config.streamMaxLengthBytes < 1
    ) {
      throw new Error("Invalid ClamAV scanner configuration");
    }

    this.semaphore = new ScanSemaphore(config.maxConcurrentScans);
  }

  async scan(body: Uint8Array): Promise<AttachmentMalwareScanResult> {
    if (body.byteLength > this.config.streamMaxLengthBytes) {
      throw new ClamAvUnavailableError(
        "Attachment exceeds the configured ClamAV stream limit",
      );
    }

    const startedAt = Date.now();
    const release = await this.semaphore.acquire(this.config.timeoutMs);

    try {
      const remainingMs = this.config.timeoutMs - (Date.now() - startedAt);

      if (remainingMs <= 0) {
        throw new ClamAvUnavailableError("ClamAV scan timed out");
      }

      return await scanWithClamAv(body, this.config, remainingMs);
    } finally {
      release();
    }
  }
}

function scanWithClamAv(
  body: Uint8Array,
  config: ClamAvScannerConfig,
  timeoutMs: number,
): Promise<AttachmentMalwareScanResult> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: config.host, port: config.port });
    const responseChunks: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;

    const fail = (message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new ClamAvUnavailableError(message, cause));
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => fail("ClamAV scan timed out"));
    socket.once("error", (error) =>
      fail("ClamAV connection or protocol failed", error),
    );
    socket.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;

      if (responseBytes > MAX_RESPONSE_BYTES) {
        fail("ClamAV returned an oversized response");
        return;
      }

      responseChunks.push(chunk);
    });
    socket.once("end", () => {
      if (settled) return;

      try {
        const result = parseClamAvResponse(Buffer.concat(responseChunks));
        settled = true;
        resolve(result);
      } catch (error: unknown) {
        fail("ClamAV returned an invalid response", error);
      }
    });
    socket.once("connect", () => {
      void writeInstream(socket, body).catch((error: unknown) =>
        fail("ClamAV stream upload failed", error),
      );
    });
  });
}

async function writeInstream(socket: Socket, body: Uint8Array): Promise<void> {
  await writeSocket(socket, INSTREAM_COMMAND);

  for (let offset = 0; offset < body.byteLength; offset += CHUNK_BYTES) {
    const chunk = body.subarray(offset, Math.min(offset + CHUNK_BYTES, body.byteLength));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(chunk.byteLength);
    await writeSocket(socket, length);
    await writeSocket(socket, chunk);
  }

  await writeSocket(socket, STREAM_TERMINATOR);
}

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off("drain", onDrain);
      reject(error);
    };
    const onDrain = (): void => {
      socket.off("error", onError);
      resolve();
    };

    socket.once("error", onError);

    if (socket.write(chunk)) {
      socket.off("error", onError);
      resolve();
      return;
    }

    socket.once("drain", onDrain);
  });
}

function parseClamAvResponse(body: Buffer): AttachmentMalwareScanResult {
  const response = body.toString("utf8").replace(/\0+$/u, "").trim();

  if (response.endsWith(" OK")) {
    return { status: "CLEAN" };
  }

  const found = /^.+?:\s*(.+)\s+FOUND$/u.exec(response);

  if (found?.[1] !== undefined) {
    return { status: "FOUND", signature: found[1] };
  }

  throw new Error(`Unexpected ClamAV response: ${response}`);
}
