import type { Readable } from "node:stream";

export interface PresignedPutRequest {
  url: string;
  method: "PUT";
  headers: Readonly<Record<string, string>>;
  expiresAt: Date;
}

export interface StoredObjectMetadata {
  contentLength: number | undefined;
  contentType: string | undefined;
  etag: string | undefined;
  lastModified: Date | undefined;
  metadata: Readonly<Record<string, string>>;
}

export interface StoredObject extends StoredObjectMetadata {
  body: Uint8Array;
}

export type StorageBody = Uint8Array | Readable | string;

export interface PutStoredObjectInput {
  bucket: string;
  key: string;
  body: StorageBody;
  contentType: string;
  cacheControl?: string;
  metadata?: Readonly<Record<string, string>>;
}

export interface PresignPutInput {
  bucket: string;
  key: string;
  contentType: string;
  expiresInSeconds: number;
}

export interface ObjectLocation {
  bucket: string;
  key: string;
}

export interface GetStoredObjectOptions {
  maxBytes?: number;
}

export interface ObjectStorage {
  presignPut(input: PresignPutInput): Promise<PresignedPutRequest>;
  headObject(location: ObjectLocation): Promise<StoredObjectMetadata>;
  getObject(
    location: ObjectLocation,
    options?: GetStoredObjectOptions,
  ): Promise<StoredObject>;
  putObject(input: PutStoredObjectInput): Promise<void>;
  deleteObject(location: ObjectLocation): Promise<void>;
}

export class StorageObjectNotFoundError extends Error {
  public override readonly name = "StorageObjectNotFoundError";

  public constructor(
    public readonly bucket: string,
    public readonly key: string,
    cause: unknown,
  ) {
    super(`Storage object not found: ${bucket}/${key}`, { cause });
  }
}

export class StorageObjectTooLargeError extends Error {
  public override readonly name = "StorageObjectTooLargeError";

  public constructor(
    public readonly bucket: string,
    public readonly key: string,
    public readonly maxBytes: number,
  ) {
    super(`Storage object exceeds ${String(maxBytes)} bytes: ${bucket}/${key}`);
  }
}
