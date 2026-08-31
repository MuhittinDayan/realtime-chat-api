import { describe, expect, it } from "vitest";

import type {
  ObjectLocation,
  ObjectStorage,
  PresignGetInput,
  PresignedGetRequest,
  PresignPutInput,
  PresignedPutRequest,
  PutStoredObjectInput,
  StoredObject,
  StoredObjectMetadata,
} from "../../infrastructure/storage/index.js";
import { StorageObjectTooLargeError } from "../../infrastructure/storage/index.js";
import {
  InvalidAttachmentFileError,
  UnsupportedAttachmentFormatError,
} from "./attachment.errors.js";
import type {
  AttachmentImageProcessor,
  ProcessedAttachmentImage,
} from "./attachment-image.processor.js";
import type {
  AttachmentClaimResult,
  AttachmentRecord,
  AttachmentRepository,
  CompleteAttachmentData,
  CreatePendingAttachmentData,
} from "./attachment.repository.js";
import {
  AttachmentService,
  type AttachmentConversationAccessService,
} from "./attachment.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const ASSET_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function pendingAttachment(
  overrides: Partial<AttachmentRecord> = {},
): AttachmentRecord {
  return {
    id: ATTACHMENT_ID,
    assetId: ASSET_ID,
    ownerId: USER_ID,
    conversationId: CONVERSATION_ID,
    messageId: null,
    originalFileName: "photo.png",
    position: 0,
    thumbnailObjectKey: `ready/${USER_ID}/${ASSET_ID}/thumbnail.webp`,
    purgeAfter: null,
    status: "PENDING",
    declaredContentType: "image/png",
    declaredSize: 4,
    detectedContentType: null,
    actualSize: null,
    width: null,
    height: null,
    incomingObjectKey: `incoming/${USER_ID}/${ASSET_ID}`,
    readyObjectKey: `ready/${USER_ID}/${ASSET_ID}/original.webp`,
    uploadExpiresAt: new Date(NOW.getTime() + 600_000),
    readyAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class MutableConversationAccess
  implements AttachmentConversationAccessService
{
  allowed = true;

  async isActiveMember(): Promise<boolean> {
    return this.allowed;
  }
}

class FakeAttachmentRepository implements AttachmentRepository {
  attachment: AttachmentRecord | null = null;
  created: CreatePendingAttachmentData | null = null;
  claimResult: AttachmentClaimResult = "CLAIMED";
  rejected = false;

  async createPendingAttachment(data: CreatePendingAttachmentData) {
    this.created = data;
    this.attachment = pendingAttachment({
      id: data.id,
      assetId: data.assetId,
      originalFileName: data.originalFileName,
      declaredContentType: data.declaredContentType,
      declaredSize: data.declaredSize,
      incomingObjectKey: data.incomingObjectKey,
      readyObjectKey: data.readyObjectKey,
      thumbnailObjectKey: data.thumbnailObjectKey,
      uploadExpiresAt: data.uploadExpiresAt,
    });
    return this.attachment;
  }

  async findOwnedAttachment() {
    return this.attachment;
  }

  async claimForProcessing() {
    return this.claimResult;
  }

  async releaseProcessing() {}
  async markRejected() {
    this.rejected = true;
  }

  async completeAttachment(_data: CompleteAttachmentData) {
    return "COMPLETED" as const;
  }

  async clearIncomingObjectKey() {}

  async findAccessibleAttachment() {
    return this.attachment;
  }

  async listCleanupCandidates() {
    return [];
  }

  async deleteAsset() {
    return false;
  }
}

class FakeObjectStorage implements ObjectStorage {
  presignPutInput: PresignPutInput | null = null;
  presignGetInput: PresignGetInput | null = null;
  touchedStorage = false;
  getError: unknown = null;

  async presignPut(input: PresignPutInput): Promise<PresignedPutRequest> {
    this.touchedStorage = true;
    this.presignPutInput = input;
    return {
      url: "http://storage/upload",
      method: "PUT",
      headers: { "Content-Type": input.contentType },
      expiresAt: new Date(NOW.getTime() + 600_000),
    };
  }

  async presignGet(input: PresignGetInput): Promise<PresignedGetRequest> {
    this.touchedStorage = true;
    this.presignGetInput = input;
    return {
      url: "http://storage/download",
      method: "GET",
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
  }

  async headObject(): Promise<StoredObjectMetadata> {
    this.touchedStorage = true;
    return {
      contentLength: 4,
      contentType: "image/png",
      etag: "etag",
      lastModified: NOW,
      metadata: {},
    };
  }

  async getObject(): Promise<StoredObject> {
    this.touchedStorage = true;
    if (this.getError !== null) throw this.getError;
    return {
      body: new Uint8Array([1, 2, 3, 4]),
      contentLength: 4,
      contentType: "image/png",
      etag: "etag",
      lastModified: NOW,
      metadata: {},
    };
  }

  async putObject(_input: PutStoredObjectInput) {
    this.touchedStorage = true;
  }

  async deleteObject(_location: ObjectLocation) {
    this.touchedStorage = true;
  }
}

class FakeImageProcessor implements AttachmentImageProcessor {
  async process(): Promise<ProcessedAttachmentImage> {
    return {
      originalBody: new Uint8Array([1]),
      thumbnailBody: new Uint8Array([2]),
      detectedContentType: "image/png",
      width: 4_096,
      height: 2_304,
    };
  }
}

function createFixture() {
  const repository = new FakeAttachmentRepository();
  const storage = new FakeObjectStorage();
  const access = new MutableConversationAccess();
  const ids = [ATTACHMENT_ID, ASSET_ID];
  const service = new AttachmentService(
    repository,
    storage,
    new FakeImageProcessor(),
    access,
    {
      attachmentBucket: "attachments",
      uploadUrlTtlSeconds: 600,
      downloadUrlTtlSeconds: 60,
    },
    () => NOW,
    () => ids.shift() ?? ASSET_ID,
  );

  return { repository, storage, access, service };
}

describe("attachment membership boundaries", () => {
  it("rejects upload intent before allocating storage for a non-member", async () => {
    const { repository, storage, access, service } = createFixture();
    access.allowed = false;

    await expect(
      service.createUpload(USER_ID, CONVERSATION_ID, {
        contentType: "image/png",
        contentLength: 4,
        originalFileName: "photo.png",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(repository.created).toBeNull();
    expect(storage.touchedStorage).toBe(false);
  });

  it("rejects completion when membership is removed after intent", async () => {
    const { storage, access, service } = createFixture();
    await service.createUpload(USER_ID, CONVERSATION_ID, {
      contentType: "image/png",
      contentLength: 4,
      originalFileName: "photo.png",
    });
    storage.touchedStorage = false;
    access.allowed = false;

    await expect(
      service.completeUpload(USER_ID, CONVERSATION_ID, ATTACHMENT_ID),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(storage.touchedStorage).toBe(false);
  });

  it("rejects presigned GET creation for a non-member", async () => {
    const { repository, storage, access, service } = createFixture();
    repository.attachment = pendingAttachment({
      status: "READY",
      detectedContentType: "image/png",
      actualSize: 4,
      width: 640,
      height: 480,
      incomingObjectKey: null,
      readyAt: NOW,
    });
    access.allowed = false;

    await expect(
      service.createAccess(
        USER_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
        "thumbnail",
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    expect(storage.presignGetInput).toBeNull();
  });
});

describe("attachment upload validation", () => {
  it("rejects HEIC before creating a pending asset", async () => {
    const { repository, service } = createFixture();

    await expect(
      service.createUpload(USER_ID, CONVERSATION_ID, {
        contentType: "image/heic",
        contentLength: 4,
        originalFileName: "photo.heic",
      }),
    ).rejects.toBeInstanceOf(UnsupportedAttachmentFormatError);
    expect(repository.created).toBeNull();
  });

  it("rejects an object that exceeds the bounded 10 MiB download", async () => {
    const { repository, storage, service } = createFixture();
    repository.attachment = pendingAttachment();
    storage.getError = new StorageObjectTooLargeError(
      "attachments",
      pendingAttachment().incomingObjectKey ?? "incoming",
      10 * 1_024 * 1_024,
    );

    await expect(
      service.completeUpload(USER_ID, CONVERSATION_ID, ATTACHMENT_ID),
    ).rejects.toBeInstanceOf(InvalidAttachmentFileError);
    expect(repository.rejected).toBe(true);
  });
});
