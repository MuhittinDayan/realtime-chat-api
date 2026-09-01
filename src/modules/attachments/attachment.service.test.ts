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
  AttachmentKindMismatchError,
  AttachmentScanUnavailableError,
  InvalidAttachmentFileError,
  UnsupportedAttachmentFormatError,
} from "./attachment.errors.js";
import type {
  AttachmentImageProcessor,
  ProcessedAttachmentImage,
} from "./attachment-image.processor.js";
import type { AttachmentFileTypeDetector } from "./attachment-file-type.js";
import type { AttachmentPdfProcessor } from "./attachment-pdf.processor.js";
import {
  ClamAvUnavailableError,
  type AttachmentMalwareScanResult,
  type AttachmentMalwareScanner,
} from "./clamav-scanner.js";
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
    kind: "IMAGE",
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
  releasedForRetry = false;
  completedData: CompleteAttachmentData | null = null;

  async createPendingAttachment(data: CreatePendingAttachmentData) {
    this.created = data;
    this.attachment = pendingAttachment({
      id: data.id,
      assetId: data.assetId,
      originalFileName: data.originalFileName,
      kind: data.kind,
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
  async releaseProcessingForRetry() {
    this.releasedForRetry = true;
    if (this.attachment !== null) this.attachment.status = "PENDING";
    return true;
  }
  async markRejected() {
    this.rejected = true;
  }

  async completeAttachment(data: CompleteAttachmentData) {
    this.completedData = data;
    if (this.attachment !== null) {
      this.attachment = pendingAttachment({
        ...this.attachment,
        status: "READY",
        detectedContentType: data.detectedContentType,
        actualSize: data.actualSize,
        width: data.width,
        height: data.height,
        readyAt: data.readyAt,
      });
    }
    return "COMPLETED" as const;
  }

  async clearIncomingObjectKey() {}

  async findAccessibleAttachment() {
    return this.attachment;
  }

  async listCleanupCandidates() {
    return [];
  }

  async resetStaleProcessing() {
    return 0;
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
  storedBody = new Uint8Array([1, 2, 3, 4]);
  storedContentType = "image/png";
  putInputs: PutStoredObjectInput[] = [];

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
      contentLength: this.storedBody.byteLength,
      contentType: this.storedContentType,
      etag: "etag",
      lastModified: NOW,
      metadata: {},
    };
  }

  async getObject(): Promise<StoredObject> {
    this.touchedStorage = true;
    if (this.getError !== null) throw this.getError;
    return {
      body: this.storedBody,
      contentLength: this.storedBody.byteLength,
      contentType: this.storedContentType,
      etag: "etag",
      lastModified: NOW,
      metadata: {},
    };
  }

  async putObject(input: PutStoredObjectInput) {
    this.touchedStorage = true;
    this.putInputs.push(input);
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

class FakeFileTypeDetector implements AttachmentFileTypeDetector {
  detectedContentType = "image/png";

  async detect(): Promise<string> {
    return this.detectedContentType;
  }
}

class FakePdfProcessor implements AttachmentPdfProcessor {
  validated = false;
  error: unknown = null;

  async validate(): Promise<void> {
    this.validated = true;
    if (this.error !== null) throw this.error;
  }
}

class FakeMalwareScanner implements AttachmentMalwareScanner {
  scanned = false;
  result: AttachmentMalwareScanResult = { status: "CLEAN" };
  error: unknown = null;

  async scan(): Promise<AttachmentMalwareScanResult> {
    this.scanned = true;
    if (this.error !== null) throw this.error;
    return this.result;
  }
}

function createFixture() {
  const repository = new FakeAttachmentRepository();
  const storage = new FakeObjectStorage();
  const access = new MutableConversationAccess();
  const detector = new FakeFileTypeDetector();
  const pdfProcessor = new FakePdfProcessor();
  const malwareScanner = new FakeMalwareScanner();
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
    pdfProcessor,
    malwareScanner,
    detector,
  );

  return {
    repository,
    storage,
    access,
    detector,
    pdfProcessor,
    malwareScanner,
    service,
  };
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

describe("PDF attachment lifecycle", () => {
  async function createPdfIntent(
    fixture: ReturnType<typeof createFixture>,
    originalFileName = "report.pdf",
  ): Promise<void> {
    fixture.detector.detectedContentType = "application/pdf";
    fixture.storage.storedContentType = "application/pdf";
    await fixture.service.createUpload(USER_ID, CONVERSATION_ID, {
      contentType: "application/pdf",
      contentLength: fixture.storage.storedBody.byteLength,
      originalFileName,
    });
  }

  it("stores a validated clean PDF without image metadata", async () => {
    const fixture = createFixture();
    await createPdfIntent(fixture);

    const completed = await fixture.service.completeUpload(
      USER_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
    );

    expect(completed).toEqual({
      id: ATTACHMENT_ID,
      kind: "PDF",
      originalFileName: "report.pdf",
      contentType: "application/pdf",
      url: `/api/v1/conversations/${CONVERSATION_ID}/attachments/${ATTACHMENT_ID}/original`,
    });
    expect(fixture.pdfProcessor.validated).toBe(true);
    expect(fixture.malwareScanner.scanned).toBe(true);
    expect(fixture.repository.completedData).toMatchObject({
      detectedContentType: "application/pdf",
      width: null,
      height: null,
    });
    expect(fixture.storage.putInputs).toHaveLength(1);
    expect(fixture.storage.putInputs[0]).toMatchObject({
      key: `ready/${USER_ID}/${ASSET_ID}/original.pdf`,
      body: fixture.storage.storedBody,
      contentType: "application/pdf",
    });
  });

  it("rejects a cross-kind magic-byte mismatch before parsing or scanning", async () => {
    const fixture = createFixture();
    await createPdfIntent(fixture);
    fixture.detector.detectedContentType = "image/png";

    await expect(
      fixture.service.completeUpload(
        USER_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
      ),
    ).rejects.toBeInstanceOf(AttachmentKindMismatchError);
    expect(fixture.repository.rejected).toBe(true);
    expect(fixture.pdfProcessor.validated).toBe(false);
    expect(fixture.malwareScanner.scanned).toBe(false);
  });

  it("permanently rejects malware reported by ClamAV", async () => {
    const fixture = createFixture();
    fixture.malwareScanner.result = {
      status: "FOUND",
      signature: "Eicar-Signature",
    };
    await createPdfIntent(fixture);

    await expect(
      fixture.service.completeUpload(
        USER_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
      ),
    ).rejects.toBeInstanceOf(InvalidAttachmentFileError);
    expect(fixture.repository.rejected).toBe(true);
    expect(fixture.repository.releasedForRetry).toBe(false);
    expect(fixture.storage.putInputs).toHaveLength(0);
  });

  it("returns 503 and releases PROCESSING after a transient scanner error", async () => {
    const fixture = createFixture();
    fixture.malwareScanner.error = new ClamAvUnavailableError("offline");
    await createPdfIntent(fixture);

    await expect(
      fixture.service.completeUpload(
        USER_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
      ),
    ).rejects.toBeInstanceOf(AttachmentScanUnavailableError);
    expect(fixture.repository.rejected).toBe(false);
    expect(fixture.repository.releasedForRetry).toBe(true);
    expect(fixture.repository.attachment?.status).toBe("PENDING");
  });

  it("signs PDF downloads as attachments with sanitized RFC 5987 filenames", async () => {
    const fixture = createFixture();
    fixture.repository.attachment = pendingAttachment({
      kind: "PDF",
      originalFileName: "../özgeçmiş\r\n.pdf",
      status: "READY",
      declaredContentType: "application/pdf",
      detectedContentType: "application/pdf",
      actualSize: 4,
      width: null,
      height: null,
      incomingObjectKey: null,
      readyObjectKey: `ready/${USER_ID}/${ASSET_ID}/original.pdf`,
      thumbnailObjectKey: null,
      readyAt: NOW,
    });

    await fixture.service.createAccess(
      USER_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
      "original",
    );

    expect(fixture.storage.presignGetInput).toMatchObject({
      responseContentType: "application/pdf",
      responseContentDisposition: expect.stringMatching(
        /^attachment; filename=".+"; filename\*=UTF-8''.+$/u,
      ),
    });
    expect(
      fixture.storage.presignGetInput?.responseContentDisposition,
    ).not.toMatch(/[\r\n/\\]/u);
  });
});
