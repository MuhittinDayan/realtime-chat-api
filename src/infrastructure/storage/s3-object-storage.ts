import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type {
  ObjectLocation,
  ObjectStorage,
  GetStoredObjectOptions,
  PresignPutInput,
  PresignedPutRequest,
  PutStoredObjectInput,
  StoredObject,
  StoredObjectMetadata,
} from "./object-storage.js";
import { StorageObjectNotFoundError } from "./object-storage.js";
import { StorageObjectTooLargeError } from "./object-storage.js";

type SignedUrlFactory = typeof getSignedUrl;

export interface S3StorageClientConfig {
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

function assertSafeLocation({ bucket, key }: ObjectLocation): void {
  if (bucket.length === 0) {
    throw new Error("Storage bucket cannot be empty");
  }

  const segments = key.split("/");
  if (
    key.length === 0 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Storage object key must be a safe relative path");
  }
}

function normalizeMetadata(
  output: Pick<
    StoredObjectMetadata,
    "contentLength" | "contentType" | "etag" | "lastModified"
  > & { metadata: Record<string, string> | undefined },
): StoredObjectMetadata {
  return {
    contentLength: output.contentLength,
    contentType: output.contentType,
    etag: output.etag,
    lastModified: output.lastModified,
    metadata: Object.freeze({ ...(output.metadata ?? {}) }),
  };
}

function isS3ObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const value = error as {
    name?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  return (
    value.name === "NotFound" ||
    value.name === "NoSuchKey" ||
    value.Code === "NoSuchKey" ||
    value.$metadata?.httpStatusCode === 404
  );
}

export function createS3Client(config: S3StorageClientConfig): S3Client {
  const clientConfig: S3ClientConfig = {
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    // Some S3-compatible providers do not implement optional SDK checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };

  if (config.endpoint !== undefined) {
    clientConfig.endpoint = config.endpoint;
  }

  return new S3Client(clientConfig);
}

export class S3ObjectStorage implements ObjectStorage {
  public constructor(
    private readonly client: S3Client,
    private readonly signedUrlFactory: SignedUrlFactory = getSignedUrl,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async presignPut(input: PresignPutInput): Promise<PresignedPutRequest> {
    assertSafeLocation(input);
    if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
      throw new Error("Presigned URL lifetime must be a positive integer");
    }

    const command = new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentType: input.contentType,
    });
    const url = await this.signedUrlFactory(this.client, command, {
      expiresIn: input.expiresInSeconds,
      signableHeaders: new Set(["content-type"]),
    });

    return {
      url,
      method: "PUT",
      headers: Object.freeze({ "Content-Type": input.contentType }),
      expiresAt: new Date(this.now().getTime() + input.expiresInSeconds * 1_000),
    };
  }

  public async headObject(
    location: ObjectLocation,
  ): Promise<StoredObjectMetadata> {
    assertSafeLocation(location);
    let output;
    try {
      output = await this.client.send(
        new HeadObjectCommand({ Bucket: location.bucket, Key: location.key }),
      );
    } catch (error) {
      if (isS3ObjectNotFound(error)) {
        throw new StorageObjectNotFoundError(location.bucket, location.key, error);
      }

      throw error;
    }

    return normalizeMetadata({
      contentLength: output.ContentLength,
      contentType: output.ContentType,
      etag: output.ETag,
      lastModified: output.LastModified,
      metadata: output.Metadata,
    });
  }

  public async getObject(
    location: ObjectLocation,
    options: GetStoredObjectOptions = {},
  ): Promise<StoredObject> {
    assertSafeLocation(location);
    if (
      options.maxBytes !== undefined &&
      (!Number.isInteger(options.maxBytes) || options.maxBytes <= 0)
    ) {
      throw new Error("Storage download limit must be a positive integer");
    }
    let output;
    try {
      output = await this.client.send(
        new GetObjectCommand({
          Bucket: location.bucket,
          Key: location.key,
          ...(options.maxBytes === undefined
            ? {}
            : { Range: `bytes=0-${String(options.maxBytes)}` }),
        }),
      );
    } catch (error) {
      if (isS3ObjectNotFound(error)) {
        throw new StorageObjectNotFoundError(location.bucket, location.key, error);
      }

      throw error;
    }
    if (output.Body === undefined) {
      throw new Error("Storage provider returned an object without a body");
    }

    const totalLength = readTotalLength(
      output.ContentRange,
      output.ContentLength,
    );

    if (
      options.maxBytes !== undefined &&
      totalLength !== undefined &&
      totalLength > options.maxBytes
    ) {
      throw new StorageObjectTooLargeError(
        location.bucket,
        location.key,
        options.maxBytes,
      );
    }

    const body = await output.Body.transformToByteArray();

    if (
      options.maxBytes !== undefined &&
      body.byteLength > options.maxBytes
    ) {
      throw new StorageObjectTooLargeError(
        location.bucket,
        location.key,
        options.maxBytes,
      );
    }

    return {
      ...normalizeMetadata({
        contentLength: totalLength,
        contentType: output.ContentType,
        etag: output.ETag,
        lastModified: output.LastModified,
        metadata: output.Metadata,
      }),
      body,
    };
  }

  public async putObject(input: PutStoredObjectInput): Promise<void> {
    assertSafeLocation(input);
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        CacheControl: input.cacheControl,
        Metadata: input.metadata === undefined ? undefined : { ...input.metadata },
      }),
    );
  }

  public async deleteObject(location: ObjectLocation): Promise<void> {
    assertSafeLocation(location);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: location.bucket, Key: location.key }),
    );
  }
}

function readTotalLength(
  contentRange: string | undefined,
  contentLength: number | undefined,
): number | undefined {
  const match = contentRange?.match(/\/(\d+)$/u);

  return match?.[1] === undefined ? contentLength : Number(match[1]);
}

export function buildPublicObjectUrl(baseUrl: string, key: string): string {
  assertSafeLocation({ bucket: "public", key });
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");

  return `${baseUrl.replace(/\/$/u, "")}/${encodedKey}`;
}
