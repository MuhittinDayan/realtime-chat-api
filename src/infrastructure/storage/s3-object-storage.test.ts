import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import {
  buildPublicObjectUrl,
  S3ObjectStorage,
} from "./s3-object-storage.js";
import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
} from "./object-storage.js";

describe("S3ObjectStorage", () => {
  it("creates a content-type-bound presigned PUT request", async () => {
    const client = { send: vi.fn() } as unknown as S3Client;
    const signedUrlFactory = vi.fn().mockResolvedValue("https://upload.test/signed");
    const storage = new S3ObjectStorage(
      client,
      signedUrlFactory,
      () => new Date("2026-08-28T10:00:00.000Z"),
    );

    const result = await storage.presignPut({
      bucket: "chat-avatars",
      key: "incoming/upload-id/source",
      contentType: "image/jpeg",
      expiresInSeconds: 600,
    });

    expect(result).toEqual({
      url: "https://upload.test/signed",
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      expiresAt: new Date("2026-08-28T10:10:00.000Z"),
    });
    expect(signedUrlFactory).toHaveBeenCalledWith(
      client,
      expect.any(PutObjectCommand),
      { expiresIn: 600, signableHeaders: new Set(["content-type"]) },
    );
    const command = signedUrlFactory.mock.calls[0]?.[1] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: "chat-avatars",
      Key: "incoming/upload-id/source",
      ContentType: "image/jpeg",
    });
  });

  it("supports head, get, put, and idempotent delete commands", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ContentLength: 123,
        ContentType: "image/webp",
        ETag: "etag",
        LastModified: new Date("2026-08-28T10:00:00.000Z"),
        Metadata: { owner: "user-id" },
      })
      .mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        },
        ContentLength: 3,
        ContentType: "image/webp",
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const client = { send } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);

    await expect(
      storage.headObject({ bucket: "chat-avatars", key: "public/avatar.webp" }),
    ).resolves.toMatchObject({
      contentLength: 123,
      contentType: "image/webp",
      etag: "etag",
      metadata: { owner: "user-id" },
    });
    await expect(
      storage.getObject({ bucket: "chat-avatars", key: "incoming/source" }),
    ).resolves.toMatchObject({
      body: new Uint8Array([1, 2, 3]),
      contentLength: 3,
      contentType: "image/webp",
    });
    await storage.putObject({
      bucket: "chat-avatars",
      key: "public/avatar.webp",
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/webp",
      cacheControl: "public, max-age=86400",
    });
    await storage.deleteObject({
      bucket: "chat-avatars",
      key: "incoming/source",
    });

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[2]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[3]?.[0]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("rejects absolute and traversal-like object keys", async () => {
    const client = { send: vi.fn() } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);

    await expect(
      storage.deleteObject({ bucket: "chat-avatars", key: "../secret" }),
    ).rejects.toThrow("safe relative path");
    await expect(
      storage.deleteObject({ bucket: "chat-avatars", key: "/public/a.webp" }),
    ).rejects.toThrow("safe relative path");
  });

  it.each([
    ["headObject", { name: "NotFound", $metadata: { httpStatusCode: 404 } }],
    ["getObject", { name: "NoSuchKey" }],
  ] as const)("maps missing objects from %s to a typed error", async (method, error) => {
    const client = {
      send: vi.fn().mockRejectedValue(error),
    } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);
    const operation = storage[method].bind(storage);

    const result = operation({ bucket: "chat-avatars", key: "incoming/missing" });

    await expect(result).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(result).rejects.toMatchObject({
      bucket: "chat-avatars",
      key: "incoming/missing",
      cause: error,
    });
  });

  it("preserves non-not-found provider errors", async () => {
    const providerError = Object.assign(new Error("storage unavailable"), {
      name: "ServiceUnavailable",
      $metadata: { httpStatusCode: 503 },
    });
    const client = {
      send: vi.fn().mockRejectedValue(providerError),
    } as unknown as S3Client;
    const storage = new S3ObjectStorage(client);

    await expect(
      storage.headObject({ bucket: "chat-avatars", key: "incoming/source" }),
    ).rejects.toBe(providerError);
  });

  it("bounds object downloads and rejects oversized content before reading the body", async () => {
    const transformToByteArray = vi.fn();
    const send = vi.fn().mockResolvedValue({
      Body: { transformToByteArray },
      ContentLength: 11,
      ContentRange: "bytes 0-10/100",
      ContentType: "image/png",
    });
    const storage = new S3ObjectStorage({ send } as unknown as S3Client);

    await expect(
      storage.getObject(
        { bucket: "chat-avatars", key: "incoming/source" },
        { maxBytes: 10 },
      ),
    ).rejects.toBeInstanceOf(StorageObjectTooLargeError);
    const command = send.mock.calls[0]?.[0] as GetObjectCommand;
    expect(command.input.Range).toBe("bytes=0-10");
    expect(transformToByteArray).not.toHaveBeenCalled();
  });
});

describe("buildPublicObjectUrl", () => {
  it("encodes key segments and normalizes the base URL", () => {
    expect(
      buildPublicObjectUrl(
        "https://assets.example.com/avatars/",
        "public/user id/avatar.webp",
      ),
    ).toBe("https://assets.example.com/avatars/public/user%20id/avatar.webp");
  });
});
