import { randomUUID } from "node:crypto";

import type {
  ObjectStorage,
  PresignedGetRequest,
} from "../../../infrastructure/storage/index.ts";
import { ConversationNotFoundError } from "../../conversations/conversation.errors.ts";
import {
  attachmentKindForContentType,
  isAttachmentContentType,
  maximumAttachmentBytesForKind,
} from "../domain/attachment.constants.ts";
import {
  AttachmentNotFoundError,
  AttachmentStorageUnavailableError,
  AttachmentUploadConflictError,
  AttachmentUploadExpiredError,
  AttachmentUploadNotFoundError,
  InvalidAttachmentFileError,
  UnsupportedAttachmentFormatError,
} from "../domain/attachment.errors.ts";
import {
  MagicByteAttachmentFileTypeDetector,
  type AttachmentFileTypeDetector,
} from "../processing/attachment-file-type.ts";
import type { AttachmentImageProcessor } from "../processing/attachment-image.processor.ts";
import { toMessageAttachmentDto } from "./attachment.mapper.js";
import type { AttachmentPdfProcessor } from "../processing/attachment-pdf.processor.ts";
import type {
  AttachmentRecord,
  AttachmentRepository,
} from "../persistence/attachment.repository.ts";
import {
  downloadResponseMetadataForKind,
  isOriginalFileNameAllowedForKind,
  storageKeysForKind,
} from "../domain/attachment-storage-policy.ts";
import type {
  AttachmentConversationAccessService,
  AttachmentServiceConfig,
  AttachmentServiceLogger,
  AttachmentUploadIntent,
  AttachmentVariant,
  CreateAttachmentUploadInput,
  MessageAttachmentDto,
} from "./attachment.types.js";
import { AttachmentUploadProcessor } from "./attachment-upload.processor.js";
import type { AttachmentMalwareScanner } from "../processing/clamav-scanner.ts";

export type {
  AttachmentConversationAccessService,
  AttachmentServiceConfig,
  AttachmentServiceLogger,
  AttachmentUploadIntent,
  AttachmentVariant,
  BaseMessageAttachmentDto,
  CreateAttachmentUploadInput,
  DocxMessageAttachmentDto,
  ImageMessageAttachmentDto,
  MessageAttachmentDto,
  PdfMessageAttachmentDto,
  PptxMessageAttachmentDto,
  XlsxMessageAttachmentDto,
} from "./attachment.types.js";
export { toMessageAttachmentDto } from "./attachment.mapper.js";
export { buildPdfContentDisposition } from "../domain/attachment-storage-policy.ts";

export class AttachmentService {
  private readonly uploadProcessor: AttachmentUploadProcessor;

  constructor(
    private readonly repository: AttachmentRepository,
    private readonly storage: ObjectStorage,
    imageProcessor: AttachmentImageProcessor,
    private readonly conversationAccessService: AttachmentConversationAccessService,
    private readonly config: AttachmentServiceConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    pdfProcessor?: AttachmentPdfProcessor,
    malwareScanner?: AttachmentMalwareScanner,
    fileTypeDetector: AttachmentFileTypeDetector =
      new MagicByteAttachmentFileTypeDetector(),
    serviceLogger?: AttachmentServiceLogger,
  ) {
    this.uploadProcessor = new AttachmentUploadProcessor(
      repository,
      storage,
      imageProcessor,
      config,
      this.now,
      pdfProcessor,
      malwareScanner,
      fileTypeDetector,
      serviceLogger,
    );
  }

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
    const maximumBytes = maximumAttachmentBytesForKind(kind);

    if (
      input.contentLength > maximumBytes ||
      !isOriginalFileNameAllowedForKind(input.originalFileName, kind)
    ) {
      throw new InvalidAttachmentFileError();
    }

    const attachmentId = this.createId();
    const assetId = this.createId();
    const incomingObjectKey = `incoming/${ownerId}/${assetId}`;
    const { readyObjectKey, thumbnailObjectKey } = storageKeysForKind(
      kind,
      ownerId,
      assetId,
    );
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

    await this.uploadProcessor.process(ownerId, initial, now);
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
        ...downloadResponseMetadataForKind(
          attachment.kind,
          attachment.originalFileName,
        ),
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
