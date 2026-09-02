import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
} from "../../../infrastructure/storage/index.ts";
import { ConversationNotFoundError } from "../../conversations/conversation.errors.ts";
import {
  ATTACHMENT_PDF_CONTENT_TYPE,
  attachmentKindForContentType,
  isAttachmentContentType,
  maximumAttachmentBytesForKind,
  type AttachmentContentType,
} from "../domain/attachment.constants.ts";
import {
  AttachmentKindMismatchError,
  AttachmentScanUnavailableError,
  AttachmentStorageUnavailableError,
  AttachmentUploadConflictError,
  AttachmentUploadIncompleteError,
  InvalidAttachmentFileError,
} from "../domain/attachment.errors.ts";
import type { AttachmentFileTypeDetector } from "../processing/attachment-file-type.ts";
import type { AttachmentImageProcessor } from "../processing/attachment-image.processor.ts";
import {
  AttachmentPdfValidationError,
  type AttachmentPdfProcessor,
} from "../processing/attachment-pdf.processor.ts";
import type {
  AttachmentRecord,
  AttachmentRepository,
} from "../persistence/attachment.repository.ts";
import type {
  AttachmentServiceConfig,
  AttachmentServiceLogger,
} from "./attachment.types.js";
import {
  ClamAvUnavailableError,
  type AttachmentMalwareScanner,
} from "../processing/clamav-scanner.ts";

export class AttachmentUploadProcessor {
  constructor(
    private readonly repository: AttachmentRepository,
    private readonly storage: ObjectStorage,
    private readonly imageProcessor: AttachmentImageProcessor,
    private readonly config: AttachmentServiceConfig,
    private readonly now: () => Date,
    private readonly pdfProcessor: AttachmentPdfProcessor | undefined,
    private readonly malwareScanner: AttachmentMalwareScanner | undefined,
    private readonly fileTypeDetector: AttachmentFileTypeDetector,
    private readonly serviceLogger: AttachmentServiceLogger | undefined,
  ) { }

  async process(
    ownerId: string,
    attachment: AttachmentRecord,
    claimedAt: Date,
  ): Promise<void> {
    const incomingObjectKey = requireObjectKey(attachment.incomingObjectKey);
    const readyObjectKey = requireObjectKey(attachment.readyObjectKey);
    const maximumBytes = maximumAttachmentBytesForKind(attachment.kind);
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
          claimedAt,
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

    const kind = attachment.kind;

    switch (kind) {
      case "IMAGE":
        await this.processImageUpload(
          ownerId,
          attachment,
          stored.body,
          readyObjectKey,
        );
        return;
      case "PDF":
        await this.processPdfUpload(
          ownerId,
          attachment,
          stored.body,
          readyObjectKey,
        );
        return;
      case "DOCX":
      case "XLSX":
      case "PPTX":
        await this.processOfficeUpload(
          ownerId,
          attachment,
          stored.body,
          readyObjectKey,
          detectedContentType,
        );
        return;
      default:
        assertNever(kind);
    }
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

    await this.scanAndStoreOriginalUpload(
      ownerId,
      attachment,
      body,
      readyObjectKey,
      ATTACHMENT_PDF_CONTENT_TYPE,
      malwareScanner,
    );
  }

  private async processOfficeUpload(
    ownerId: string,
    attachment: AttachmentRecord,
    body: Uint8Array,
    readyObjectKey: string,
    detectedContentType: AttachmentContentType,
  ): Promise<void> {
    const malwareScanner = this.malwareScanner;

    if (malwareScanner === undefined) {
      return this.releaseAfterTransientScanFailure(ownerId, attachment, {
        reason: "SCANNER_NOT_CONFIGURED",
      });
    }

    await this.scanAndStoreOriginalUpload(
      ownerId,
      attachment,
      body,
      readyObjectKey,
      detectedContentType,
      malwareScanner,
    );
  }

  private async scanAndStoreOriginalUpload(
    ownerId: string,
    attachment: AttachmentRecord,
    body: Uint8Array,
    readyObjectKey: string,
    contentType: AttachmentContentType,
    malwareScanner: AttachmentMalwareScanner,
  ): Promise<void> {
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
        contentType,
      });
    } catch (error: unknown) {
      await this.repository.releaseProcessingForRetry(ownerId, attachment.assetId);
      throw new AttachmentStorageUnavailableError(error);
    }

    await this.completeProcessedAttachment(ownerId, attachment, {
      detectedContentType: contentType,
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
      {
        attachmentId: attachment.id,
        assetId: attachment.assetId,
        reason,
        ...context,
      },
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
      error instanceof ClamAvUnavailableError
        ? error
        : new ClamAvUnavailableError("ClamAV scan failed", error),
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
      actualSize > maximumAttachmentBytesForKind(attachment.kind)
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
    const contentType = stored.contentType
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();

    if (
      contentType !== attachment.declaredContentType ||
      stored.contentLength !== attachment.declaredSize ||
      stored.contentLength > maximumAttachmentBytesForKind(attachment.kind)
    ) {
      throw new InvalidAttachmentFileError();
    }
  }
}

function requireObjectKey(value: string | null): string {
  if (value === null) {
    throw new AttachmentUploadConflictError();
  }

  return value;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported attachment kind: ${String(value)}`);
}
