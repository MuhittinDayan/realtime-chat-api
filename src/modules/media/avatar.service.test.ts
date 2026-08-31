import { describe, expect, it } from "vitest";

import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
} from "../../infrastructure/storage/index.js";
import type {
  ObjectLocation,
  ObjectStorage,
  PresignPutInput,
  PresignGetInput,
  PresignedGetRequest,
  PresignedPutRequest,
  PutStoredObjectInput,
  StoredObject,
  StoredObjectMetadata,
} from "../../infrastructure/storage/index.js";
import type { UserRecord } from "../auth/auth.repository.js";
import {
  AvatarStorageUnavailableError,
  AvatarUploadExpiredError,
  AvatarUploadIncompleteError,
  InvalidAvatarFileError,
  UnsupportedAvatarFormatError,
} from "./avatar.errors.js";
import type {
  AvatarImageProcessor,
  ProcessedAvatarImage,
} from "./avatar-image.processor.js";
import type {
  AvatarAssetRecord,
  AvatarCleanupCandidate,
  AvatarRepository,
  CompleteAvatarData,
  CreatePendingAvatarData,
} from "./avatar.repository.js";
import { AvatarService } from "./avatar.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function activeUser(avatarUrl: string | null = null): UserRecord {
  return {
    id: USER_ID,
    email: "alice@example.com",
    username: "alice",
    displayName: "Alice",
    avatarUrl,
    status: "ACTIVE",
    createdAt: NOW,
    deletedAt: null,
  };
}

function pendingAsset(
  overrides: Partial<AvatarAssetRecord> = {},
): AvatarAssetRecord {
  return {
    id: UPLOAD_ID,
    ownerId: USER_ID,
    status: "PENDING",
    declaredContentType: "image/png",
    declaredSize: 4,
    incomingObjectKey: `incoming/${UPLOAD_ID}`,
    readyObjectKey: `public/${UPLOAD_ID}.webp`,
    publicUrl: `http://storage/avatars/public/${UPLOAD_ID}.webp`,
    uploadExpiresAt: new Date(NOW.getTime() + 600_000),
    updatedAt: NOW,
    isCurrent: false,
    ...overrides,
  };
}

class FakeAvatarRepository implements AvatarRepository {
  asset: AvatarAssetRecord | null = pendingAsset();
  user: UserRecord | null = activeUser();
  created: CreatePendingAvatarData | null = null;
  completed: CompleteAvatarData | null = null;
  completeError: unknown = null;
  rejected = false;
  released = false;
  claimed = true;

  async createPendingAvatar(data: CreatePendingAvatarData) {
    this.created = data;
    this.asset = pendingAsset({
      id: data.id,
      declaredContentType: data.declaredContentType,
      declaredSize: data.declaredSize,
      incomingObjectKey: data.incomingObjectKey,
      readyObjectKey: data.readyObjectKey,
      publicUrl: data.publicUrl,
      uploadExpiresAt: data.uploadExpiresAt,
    });
    return this.asset;
  }

  async findOwnedAvatar() {
    return this.asset;
  }

  async claimForProcessing() {
    return this.claimed;
  }

  async releaseProcessing() {
    this.released = true;
  }

  async markRejected() {
    this.rejected = true;
  }

  async completeAvatar(data: CompleteAvatarData) {
    this.completed = data;
    if (this.completeError !== null) throw this.completeError;
    return this.user;
  }

  async getCurrentUser() {
    return this.user;
  }

  async removeCurrentAvatar() {
    return this.user;
  }

  async listCleanupCandidates(): Promise<readonly AvatarCleanupCandidate[]> {
    return [];
  }

  async clearIncomingObjectKey() {}

  async deleteUnreferencedAsset() {
    return true;
  }
}

class FakeObjectStorage implements ObjectStorage {
  presignError: unknown = null;
  getError: unknown = null;
  presignInput: PresignPutInput | null = null;
  putInput: PutStoredObjectInput | null = null;
  stored: StoredObject = {
    body: new Uint8Array([1, 2, 3, 4]),
    contentLength: 4,
    contentType: "image/png",
    etag: "etag",
    lastModified: NOW,
    metadata: {},
  };

  async presignPut(input: PresignPutInput): Promise<PresignedPutRequest> {
    this.presignInput = input;
    if (this.presignError !== null) throw this.presignError;
    return {
      url: "http://storage/signed",
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      expiresAt: new Date(NOW.getTime() + 600_000),
    };
  }

  async presignGet(_input: PresignGetInput): Promise<PresignedGetRequest> {
    throw new Error("not used");
  }

  async headObject(): Promise<StoredObjectMetadata> {
    return this.stored;
  }

  async getObject(): Promise<StoredObject> {
    if (this.getError !== null) throw this.getError;
    return this.stored;
  }

  async putObject(input: PutStoredObjectInput) {
    this.putInput = input;
  }

  async deleteObject(_location: ObjectLocation) {}
}

class FakeImageProcessor implements AvatarImageProcessor {
  error: unknown = null;

  async process(): Promise<ProcessedAvatarImage> {
    if (this.error !== null) throw this.error;
    return {
      body: new Uint8Array([9, 8, 7]),
      detectedContentType: "image/png",
      width: 512,
      height: 512,
    };
  }
}

function createFixture() {
  const repository = new FakeAvatarRepository();
  const storage = new FakeObjectStorage();
  const processor = new FakeImageProcessor();
  const service = new AvatarService(
    repository,
    storage,
    processor,
    {
      avatarBucket: "avatars",
      publicAvatarBaseUrl: "http://storage/avatars",
      uploadUrlTtlSeconds: 600,
      cacheControl: "public, max-age=86400",
    },
    () => NOW,
    () => UPLOAD_ID,
  );

  return { repository, storage, processor, service };
}

describe("avatar service", () => {
  it("creates a private incoming upload and reserves its public URL", async () => {
    const { repository, storage, service } = createFixture();

    const result = await service.createUpload(USER_ID, {
      contentType: "image/png",
      contentLength: 4,
    });

    expect(repository.created).toEqual(
      expect.objectContaining({
        id: UPLOAD_ID,
        incomingObjectKey: `incoming/${UPLOAD_ID}`,
        readyObjectKey: `public/${UPLOAD_ID}.webp`,
        publicUrl: `http://storage/avatars/public/${UPLOAD_ID}.webp`,
      }),
    );
    expect(storage.presignInput).toEqual({
      bucket: "avatars",
      key: `incoming/${UPLOAD_ID}`,
      contentType: "image/png",
      expiresInSeconds: 600,
    });
    expect(result.upload.method).toBe("PUT");
  });

  it("maps signing failures to a storage-unavailable response", async () => {
    const { storage, service } = createFixture();
    storage.presignError = new Error("offline");

    await expect(
      service.createUpload(USER_ID, {
        contentType: "image/png",
        contentLength: 4,
      }),
    ).rejects.toBeInstanceOf(AvatarStorageUnavailableError);
  });

  it("rejects HEIC before creating an upload record", async () => {
    const { repository, service } = createFixture();

    await expect(
      service.createUpload(USER_ID, {
        contentType: "image/heic",
        contentLength: 4,
      }),
    ).rejects.toBeInstanceOf(UnsupportedAvatarFormatError);
    expect(repository.created).toBeNull();
  });

  it("validates, transforms, stores, and attaches the completed avatar", async () => {
    const { repository, storage, service } = createFixture();
    repository.user = activeUser(
      `http://storage/avatars/public/${UPLOAD_ID}.webp`,
    );

    const user = await service.completeUpload(USER_ID, UPLOAD_ID);

    expect(storage.putInput).toEqual(
      expect.objectContaining({
        bucket: "avatars",
        key: `public/${UPLOAD_ID}.webp`,
        contentType: "image/webp",
        cacheControl: "public, max-age=86400",
      }),
    );
    expect(repository.completed).toEqual(
      expect.objectContaining({
        assetId: UPLOAD_ID,
        actualSize: 4,
        width: 512,
        height: 512,
      }),
    );
    expect(user.avatarUrl).toContain(`${UPLOAD_ID}.webp`);
  });

  it("rejects an expired upload before touching storage", async () => {
    const { repository, service } = createFixture();
    repository.asset = pendingAsset({ uploadExpiresAt: NOW });

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBeInstanceOf(AvatarUploadExpiredError);
  });

  it("keeps an upload retryable when its object is not present yet", async () => {
    const { repository, storage, service } = createFixture();
    storage.getError = new StorageObjectNotFoundError(
      "avatars",
      `incoming/${UPLOAD_ID}`,
      new Error("missing"),
    );

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBeInstanceOf(AvatarUploadIncompleteError);
    expect(repository.released).toBe(true);
  });

  it("rejects content that does not match the declared size", async () => {
    const { repository, storage, service } = createFixture();
    storage.stored = { ...storage.stored, contentLength: 3 };

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBeInstanceOf(InvalidAvatarFileError);
    expect(repository.rejected).toBe(true);
  });

  it("rejects a storage object that exceeds the bounded download", async () => {
    const { repository, storage, service } = createFixture();
    storage.getError = new StorageObjectTooLargeError(
      "avatars",
      `incoming/${UPLOAD_ID}`,
      5 * 1_024 * 1_024,
    );

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBeInstanceOf(InvalidAvatarFileError);
    expect(repository.rejected).toBe(true);
  });

  it("rejects a file the image decoder cannot safely process", async () => {
    const { repository, processor, service } = createFixture();
    processor.error = new InvalidAvatarFileError();

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBeInstanceOf(InvalidAvatarFileError);
    expect(repository.rejected).toBe(true);
  });

  it("returns the current profile for a completed retry without reprocessing", async () => {
    const { repository, storage, service } = createFixture();
    repository.asset = pendingAsset({ status: "READY", isCurrent: true });
    repository.user = activeUser("http://storage/avatar.webp");

    const result = await service.completeUpload(USER_ID, UPLOAD_ID);

    expect(result.avatarUrl).toBe("http://storage/avatar.webp");
    expect(storage.putInput).toBeNull();
  });

  it("does not misreport a database completion failure as storage downtime", async () => {
    const { repository, service } = createFixture();
    const databaseError = new Error("database offline");
    repository.completeError = databaseError;

    await expect(
      service.completeUpload(USER_ID, UPLOAD_ID),
    ).rejects.toBe(databaseError);
  });

  it("removes only the user's avatar reference", async () => {
    const { repository, service } = createFixture();
    repository.user = activeUser(null);

    const result = await service.deleteAvatar(USER_ID);

    expect(result.avatarUrl).toBeNull();
  });
});
