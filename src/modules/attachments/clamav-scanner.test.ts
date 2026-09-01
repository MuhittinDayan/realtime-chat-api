import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClamAvAttachmentScanner,
  ClamAvUnavailableError,
} from "./clamav-scanner.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("ClamAvAttachmentScanner", () => {
  it("uses INSTREAM and maps a clean response", async () => {
    const received: Buffer[] = [];
    const port = await listen((socket) => {
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        const body = Buffer.concat(received);

        if (body.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end("stream: OK\0");
        }
      });
    });
    const scanner = createScanner(port);

    await expect(scanner.scan(new Uint8Array([1, 2, 3, 4]))).resolves.toEqual({
      status: "CLEAN",
    });
    expect(Buffer.concat(received).subarray(0, 10).toString("ascii")).toBe(
      "zINSTREAM\0",
    );
  });

  it("returns the malware signature from FOUND", async () => {
    const port = await listen((socket) => {
      socket.on("data", (chunk: Buffer) => {
        if (chunk.subarray(-4).equals(Buffer.alloc(4))) {
          socket.end("stream: Eicar-Signature FOUND\0");
        }
      });
    });

    await expect(createScanner(port).scan(new Uint8Array([1]))).resolves.toEqual({
      status: "FOUND",
      signature: "Eicar-Signature",
    });
  });

  it("classifies an unavailable daemon as transient", async () => {
    const port = await reserveClosedPort();

    await expect(
      createScanner(port).scan(new Uint8Array([1])),
    ).rejects.toBeInstanceOf(ClamAvUnavailableError);
  });

  it("refuses a body above the configured stream limit before connecting", async () => {
    const scanner = new ClamAvAttachmentScanner({
      host: "127.0.0.1",
      port: 33_109,
      timeoutMs: 200,
      maxConcurrentScans: 1,
      streamMaxLengthBytes: 1,
    });

    await expect(scanner.scan(new Uint8Array([1, 2]))).rejects.toBeInstanceOf(
      ClamAvUnavailableError,
    );
  });
});

function createScanner(port: number): ClamAvAttachmentScanner {
  return new ClamAvAttachmentScanner({
    host: "127.0.0.1",
    port,
    timeoutMs: 1_000,
    maxConcurrentScans: 1,
    streamMaxLengthBytes: 1_024,
  });
}

function listen(onConnection: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(onConnection);
    openServers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address === "string" || address === null) {
        reject(new Error("Test server did not expose a TCP port"));
        return;
      }

      resolve(address.port);
    });
  });
}

async function reserveClosedPort(): Promise<number> {
  const port = await listen(() => undefined);
  const server = openServers.pop();

  if (server === undefined) throw new Error("Test server is missing");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
