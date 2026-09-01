import { randomUUID } from "node:crypto";

import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
  type PresignedGetRequest,
} from "../../infrastructure/storage/index.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import {
  attachmentKindForContentType,
  isAttachmentContentType,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
} from "./attachment.constants.js";
import {
  AttachmentKindMismatchError,
  AttachmentNotFoundError,
  AttachmentScanUnavailableError,
  AttachmentStorageUnavailableError,
  AttachmentUploadConflictError,
  AttachmentUploadExpiredError,
  AttachmentUploadIncompleteError,
  AttachmentUploadNotFoundError,
  InvalidAttachmentFileError,
  UnsupportedAttachmentFormatError,
} from "./attachment.errors.js";
import {
  MagicByteAttachmentFileTypeDetector,
  type AttachmentFileTypeDetector,
} from "./attachment-file-type.js";
import type { AttachmentImageProcessor } from "./attachment-image.processor.js";
import {
  AttachmentPdfValidationError,
  type AttachmentPdfProcessor,
} from "./attachment-pdf.processor.js";
import {
  ClamAvUnavailableError,
  type AttachmentMalwareScanner,
} from "./clamav-scanner.js";
import type {
  AttachmentRecord,
  AttachmentRepository,
} from "./attachment.repository.js";

export interface AttachmentConversationAccessService {
  isActiveMember(conversationId: string, userId: string): Promise<boolean>;
}

export interface AttachmentServiceConfig {
  attachmentBucket: string;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
}

export interface AttachmentServiceLogger {
  warn(context: object, message: string): void;
}

export interface CreateAttachmentUploadInput {
  contentType: string;
  contentLength: number;
  originalFileName: string;
}

export interface AttachmentUploadIntent {
  attachmentId: string;
  upload: {
    url: string;
    method: "PUT";
    headers: Readonly<Record<string, string>>;
    expiresAt: Date;
  };
}

export interface BaseMessageAttachmentDto {
  id: string;
  originalFileName: string;
  kind: "IMAGE" | "PDF";
  url: string;
}

export interface ImageMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "IMAGE";
  contentType: "image/webp";
  width: number;
  height: number;
  thumbnailUrl: string;
}

export interface PdfMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "PDF";
  contentType: "application/pdf";
}

export type MessageAttachmentDto =
  | ImageMessageAttachmentDto
  | PdfMessageAttachmentDto;

export type AttachmentVariant = "original" | "thumbnail";

export class AttachmentService {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly storage: ObjectStorage,
    private readonly imageProcessor: AttachmentImageProcessor,
    private readonly conversationAccessService: AttachmentConversationAccessService,
    private readonly config: AttachmentServiceConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly pdfProcessor?: AttachmentPdfProcessor,
    private readonly malwareScanner?: AttachmentMalwareScanner,
    private readonly fileTypeDetector: AttachmentFileTypeDetector =
      new MagicByteAttachmentFileTypeDetector(),
    private readonly serviceLogger?: AttachmentServiceLogger,
  ) {}

  async createUpload(
    ownerId: string,
    conversationId: string,
    input: CreateAttachmentUploadInput,
  ): Promise<AttachmentUploadIntent> {
    await this.ensureActiveMember(conversationId, ownerId);

    if (!isAttachmentContentType(input.contentType)) {
      throw new UnsupportedAttachmentFormatError();
    }

    const kind = attachmentKindForContentType(input.contentType);
    const maximumBytes = maximumBytesForKind(kind);

    if (input.contentLength > maximumBytes) {
      throw new InvalidAttachmentFileError();
    }

    const attachmentId = this.createId();
    const assetId = this.createId();
    const incomingObjectKey = `incoming/${ownerId}/${assetId}`;
    const readyObjectKey =
      kind === "PDF"
        ? `ready/${ownerId}/${assetId}/original.pdf`
        : `ready/${ownerId}/${assetId}/original.webp`;
    const thumbnailObjectKey =
      kind === "IMAGE"
        ? `ready/${ownerId}/${assetId}/thumbnail.webp`
        : null;
    const uploadExpiresAt = new Date(
      this.now().getTime() + this.config.uploadUrlTtlSeconds * 1_000,
    );
    const attachment = await this.repository.createPendingAttachment({
      id: attachmentId,
      assetId,
      ownerId,
      conversationId,
      originalFileName: input.originalFileName,
      kind,
      declaredContentType: input.contentType,
      declaredSize: input.contentLength,
      incomingObjectKey,
      readyObjectKey,
      thumbnailObjectKey,
      uploadExpiresAt,
    });

    if (attachment === null) {
      throw new ConversationNotFoundError();
    }

    try {
      const upload = await this.storage.presignPut({
        bucket: this.config.attachmentBucket,
        key: incomingObjectKey,
        contentType: input.contentType,
        expiresInSeconds: this.config.uploadUrlTtlSeconds,
      });

      return { attachmentId, upload };
    } catch (error: unknown) {
      throw new AttachmentStorageUnavailableError(error);
    }
  }

  async completeUpload(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<MessageAttachmentDto> {
    await this.ensureActiveMember(conversationId, ownerId);
    const initial = await this.repository.findOwnedAttachment(
      ownerId,
      conversationId,
      attachmentId,
    );

    if (initial === null) {
      throw new AttachmentUploadNotFoundError();
    }

    if (initial.status === "READY") {
      await this.removeIncomingObject(initial);
      return toMessageAttachmentDto(initial);
    }

    const now = this.now();
    this.assertPendingAndCurrent(initial, now);
    const claim = await this.repository.claimForProcessing(
      ownerId,
      conversationId,
      attachmentId,
      now,
    );

    if (claim === "CONVERSATION_NOT_FOUND") {
      throw new ConversationNotFoundError();
    }

    if (claim !== "CLAIMED") {
      const latest = await this.repository.findOwnedAttachment(
        ownerId,
        conversationId,
        attachmentId,
      );

      if (latest?.status === "READY") {
        await this.removeIncomingObject(latest);
        return toMessageAttachmentDto(latest);
      }

      throw new AttachmentUploadConflictError();
    }

    await this.processClaimedUpload(ownerId, initial, now);
    const completed = await this.repository.findOwnedAttachment(
      ownerId,
      conversationId,
      attachmentId,
    );

    if (completed === null || completed.status !== "READY") {
      throw new AttachmentUploadConflictError();
    }

    await this.removeIncomingObject(completed);
    return toMessageAttachmentDto(completed);
  }

  async createAccess(
    userId: string,
    conversationId: string,
    attachmentId: string,
    variant: AttachmentVariant,
  ): Promise<PresignedGetRequest> {
    await this.ensureActiveMember(conversationId, userId);
    const attachment = await this.repository.findAccessibleAttachment(
      conversationId,
      attachmentId,
    );

    if (attachment === null) {
      throw new AttachmentNotFoundError();
    }

    const key =
      variant === "thumbnail"
        ? attachment.thumbnailObjectKey
        : attachment.readyObjectKey;

    if (key === null) {
      throw new AttachmentNotFoundError();
    }

    try {
      return await this.storage.presignGet({
        bucket: this.config.attachmentBucket,
        key,
        expiresInSeconds: this.config.downloadUrlTtlSeconds,
        ...(attachment.kind === "PDF"
          ? {
              responseContentDisposition: buildPdfContentDisposition(
                attachment.originalFileName,
              ),
              responseContentType: "application/pdf",
            }
          : {}),
      });
    } catch (error: unknown) {
      throw new AttachmentStorageUnavailableError(error);
    }
  }

  private async ensureActiveMember(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    if (
      !(await this.conversationAccessService.isActiveMember(
        conversationId,
        userId,
      ))
    ) {
      throw new ConversationNotFoundError();
    }
  }

  private assertPendingAndCurrent(
    attachment: AttachmentRecord,
    now: Date,
  ): void {
    if (attachment.status !== "PENDING") {
      throw new AttachmentUploadConflictError();
    }

    if (attachment.uploadExpiresAt.getTime() <= now.getTime()) {
      throw new AttachmentUploadExpiredError();
    }
  }

  private async processClaimedUpload(
    ownerId: string,
    attachment: AttachmentRecord,
    now: Date,
  ): Promise<void> {
    const incomingObjectKey = requireObjectKey(attachment.incomingObjectKey);
    const readyObjectKey = requireObjectKey(attachment.readyObjectKey);
    const maximumBytes = maximumBytesForKind(attachment.kind);
    const location = {
      bucket: this.config.attachmentBucket,
      key: incomingObjectKey,
    };
    let stored;

    try {
      const metadata = await this.storage.headObject(location);
      this.assertStoredMetadataMatchesIntent(attachment, metadata);
      stored = await this.storage.getObject(location, {
        maxBytes: maximumBytes,
      });
      this.assertStoredObjectMatchesIntent(attachment, stored);
    } catch (error: unknown) {
      if (error instanceof InvalidAttachmentFileError) {
        await this.repository.markRejected(ownerId, attachment.assetId);
        throw error;
      }

      if (error instanceof StorageObjectTooLargeError) {
        await this.repository.markRejected(ownerId, attachment.assetId);
        throw new InvalidAttachmentFileError(error);
      }

      if (error instanceof StorageObjectNotFoundError) {
        await this.repository.releaseProcessing(
          ownerId,
          attachment.assetId,
          now,
        );
        throw new AttachmentUploadIncompleteError();
      }

      await this.repository.releaseProcessingForRetry(ownerId, attachment.assetId);
      throw new AttachmentStorageUnavailableError(error);
    }

    let detectedContentType: string | null;

    try {
      detectedContentType = await this.fileTypeDetector.detect(stored.body);
    } catch (error: unknown) {
      await this.rejectPermanently(ownerId, attachment, "MAGIC_BYTE_INVALID");
      throw new InvalidAttachmentFileError(error);
    }

    if (!isAttachmentContentType(detectedContentType)) {
      await this.rejectPermanently(ownerId, attachment, "MAGIC_BYTE_INVALID");
      throw new InvalidAttachmentFileError();
    }

    if (attachmentKindForContentType(detectedContentType) !== attachment.kind) {
      const error = new AttachmentKindMismatchError();
      await this.rejectPermanently(ownerId, attachment, "KIND_MISMATCH");
      throw error;
    }

    if (detectedContentType !== attachment.declaredContentType) {
      await this.rejectPermanently(ownerId, attachment, "MIME_MISMATCH");
      throw new InvalidAttachmentFileError();
    }

    if (attachment.kind === "PDF") {
      await this.processPdfUpload(ownerId, attachment, stored.body, readyObjectKey);
      return;
    }

    await this.processImageUpload(ownerId, attachment, stored.body, readyObjectKey);
  }

  private async processImageUpload(
    ownerId: string,
    attachment: AttachmentRecord,
    body: Uint8Array,
    readyObjectKey: string,
  ): Promise<void> {
    const thumbnailObjectKey = requireObjectKey(attachment.thumbnailObjectKey);
    let processed;

    try {
      processed = await this.imageProcessor.process(body);

      if (processed.detectedContentType !== attachment.declaredContentType) {
        throw new InvalidAttachmentFileError();
      }
    } catch (error: unknown) {
      await this.rejectPermanently(ownerId, attachment, "IMAGE_PROCESSING_FAILED");
      throw error;
    }

    try {
      await this.storage.putObject({
        bucket: this.config.attachmentBucket,
        key: readyObjectKey,
        body: processed.originalBody,
        contentType: "image/webp",
      });
      await this.storage.putObject({
        bucket: this.config.attachmentBucket,
        key: thumbnailObjectKey,
        body: processed.thumbnailBody,
        contentType: "image/webp",
      });
    } catch (error: unknown) {
      await this.repository.releaseProcessingForRetry(ownerId, attachment.assetId);
      throw new AttachmentStorageUnavailableError(error);
    }

    await this.completeProcessedAttachment(ownerId, attachment, {
      detectedContentType: processed.detectedContentType,
      actualSize: body.byteLength,
      width: processed.width,
      height: processed.height,
    });
  }

  private async processPdfUpload(
    ownerId: string,
    attachment: AttachmentRecord,
    body: Uint8Array,
    readyObjectKey: string,
  ): Promise<void> {
    const pdfProcessor = this.pdfProcessor;
    const malwareScanner = this.malwareScanner;

    if (pdfProcessor === undefined || malwareScanner === undefined) {
      return this.releaseAfterTransientScanFailure(ownerId, attachment, {
        reason: "SCANNER_NOT_CONFIGURED",
      });
    }

    try {
      await pdfProcessor.validate(body);
    } catch (error: unknown) {
      const reason =
        error instanceof AttachmentPdfValidationError
          ? error.reason
          : "PDF_VALIDATION_FAILED";
      await this.rejectPermanently(ownerId, attachment, reason);
      throw new InvalidAttachmentFileError(error);
    }

    let scanResult: Awaited<ReturnType<AttachmentMalwareScanner["scan"]>>;

    try {
      scanResult = await malwareScanner.scan(body);
    } catch (error: unknown) {
      return this.releaseAfterTransientScanFailure(ownerId, attachment, error);
    }

    if (scanResult.status === "FOUND") {
      await this.rejectPermanently(ownerId, attachment, "MALWARE_FOUND", {
        signature: scanResult.signature,
      });
      throw new InvalidAttachmentFileError();
    }

    try {
      await this.storage.putObject({
        bucket: this.config.attachmentBucket,
        key: readyObjectKey,
        body,
        contentType: "application/pdf",
      });
    } catch (error: unknown) {
      await this.repository.releaseProcessingForRetry(ownerId, attachment.assetId);
      throw new AttachmentStorageUnavailableError(error);
    }

    await this.completeProcessedAttachment(ownerId, attachment, {
      detectedContentType: "application/pdf",
      actualSize: body.byteLength,
      width: null,
      height: null,
    });
  }

  private async completeProcessedAttachment(
    ownerId: string,
    attachment: AttachmentRecord,
    processed: Pick<
      Parameters<AttachmentRepository["completeAttachment"]>[0],
      "detectedContentType" | "actualSize" | "width" | "height"
    >,
  ): Promise<void> {
    const completion = await this.repository.completeAttachment({
      attachmentId: attachment.id,
      assetId: attachment.assetId,
      ownerId,
      conversationId: attachment.conversationId,
      ...processed,
      readyAt: this.now(),
    });

    if (completion === "CONVERSATION_NOT_FOUND") {
      await this.repository.markRejected(ownerId, attachment.assetId);
      throw new ConversationNotFoundError();
    }

    if (completion !== "COMPLETED") {
      throw new AttachmentUploadConflictError();
    }
  }

  private async rejectPermanently(
    ownerId: string,
    attachment: AttachmentRecord,
    reason: string,
    context: object = {},
  ): Promise<void> {
    await this.repository.markRejected(ownerId, attachment.assetId);
    this.serviceLogger?.warn(
      { attachmentId: attachment.id, assetId: attachment.assetId, reason, ...context },
      "Attachment upload rejected",
    );
  }

  private async releaseAfterTransientScanFailure(
    ownerId: string,
    attachment: AttachmentRecord,
    error: unknown,
  ): Promise<never> {
    await this.repository.releaseProcessingForRetry(ownerId, attachment.assetId);
    this.serviceLogger?.warn(
      { attachmentId: attachment.id, assetId: attachment.assetId, err: error },
      "Attachment malware scan unavailable",
    );
    throw new AttachmentScanUnavailableError(
      error instanceof ClamAvUnavailableError ? error : new ClamAvUnavailableError("ClamAV scan failed", error),
    );
  }

  private assertStoredObjectMatchesIntent(
    attachment: AttachmentRecord,
    stored: {
      body: Uint8Array;
      contentLength: number | undefined;
      contentType: string | undefined;
    },
  ): void {
    this.assertStoredMetadataMatchesIntent(attachment, stored);
    const actualSize = stored.body.byteLength;

    if (
      stored.contentLength !== actualSize ||
      actualSize !== attachment.declaredSize ||
      actualSize > maximumBytesForKind(attachment.kind)
    ) {
      throw new InvalidAttachmentFileError();
    }
  }

  private assertStoredMetadataMatchesIntent(
    attachment: AttachmentRecord,
    stored: {
      contentLength: number | undefined;
      contentType: string | undefined;
    },
  ): void {
    const contentType = stored.contentType?.split(";", 1)[0]?.trim().toLowerCase();

    if (
      contentType !== attachment.declaredContentType ||
      stored.contentLength !== attachment.declaredSize ||
      stored.contentLength > maximumBytesForKind(attachment.kind)
    ) {
      throw new InvalidAttachmentFileError();
    }
  }

  private async removeIncomingObject(
    attachment: AttachmentRecord,
  ): Promise<void> {
    if (attachment.incomingObjectKey === null) {
      return;
    }

    try {
      await this.storage.deleteObject({
        bucket: this.config.attachmentBucket,
        key: attachment.incomingObjectKey,
      });
      await this.repository.clearIncomingObjectKey(
        attachment.assetId,
        attachment.incomingObjectKey,
      );
    } catch (error: unknown) {
      throw new AttachmentStorageUnavailableError(error);
    }
  }
}

function requireObjectKey(value: string | null): string {
  if (value === null) {
    throw new AttachmentUploadConflictError();
  }

  return value;
}

export function toMessageAttachmentDto(
  attachment: AttachmentRecord,
): MessageAttachmentDto {
  if (attachment.status !== "READY" || attachment.readyObjectKey === null) {
    throw new AttachmentUploadConflictError();
  }

  const basePath =
    `/api/v1/conversations/${attachment.conversationId}` +
    `/attachments/${attachment.id}`;

  if (attachment.kind === "PDF") {
    if (attachment.detectedContentType !== "application/pdf") {
      throw new AttachmentUploadConflictError();
    }

    return {
      id: attachment.id,
      kind: "PDF",
      originalFileName: attachment.originalFileName,
      contentType: "application/pdf",
      url: `${basePath}/original`,
    };
  }

  if (
    attachment.width === null ||
    attachment.height === null ||
    attachment.thumbnailObjectKey === null
  ) {
    throw new AttachmentUploadConflictError();
  }

  return {
    id: attachment.id,
    kind: "IMAGE",
    originalFileName: attachment.originalFileName,
    contentType: "image/webp",
    width: attachment.width,
    height: attachment.height,
    url: `${basePath}/original`,
    thumbnailUrl: `${basePath}/thumbnail`,
  };
}

function maximumBytesForKind(kind: AttachmentRecord["kind"]): number {
  return kind === "PDF"
    ? MAX_PDF_ATTACHMENT_BYTES
    : MAX_IMAGE_ATTACHMENT_BYTES;
}

export function buildPdfContentDisposition(originalFileName: string): string {
  const sanitized = originalFileName
    .replace(/[\u0000-\u001f\u007f/\\]+/gu, "_")
    .trim();
  const safeName = sanitized.length === 0 ? "attachment.pdf" : sanitized;
  const asciiFallback =
    safeName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_") || "attachment.pdf";
  const encoded = encodeURIComponent(safeName).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
