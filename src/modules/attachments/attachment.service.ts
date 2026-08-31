import { randomUUID } from "node:crypto";

import {
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
  type PresignedGetRequest,
} from "../../infrastructure/storage/index.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import {
  isAttachmentContentType,
  MAX_ATTACHMENT_BYTES,
} from "./attachment.constants.js";
import {
  AttachmentNotFoundError,
  AttachmentStorageUnavailableError,
  AttachmentUploadConflictError,
  AttachmentUploadExpiredError,
  AttachmentUploadIncompleteError,
  AttachmentUploadNotFoundError,
  InvalidAttachmentFileError,
  UnsupportedAttachmentFormatError,
} from "./attachment.errors.js";
import type { AttachmentImageProcessor } from "./attachment-image.processor.js";
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

export interface MessageAttachmentDto {
  id: string;
  originalFileName: string;
  contentType: "image/webp";
  width: number;
  height: number;
  url: string;
  thumbnailUrl: string;
}

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

    const attachmentId = this.createId();
    const assetId = this.createId();
    const incomingObjectKey = `incoming/${ownerId}/${assetId}`;
    const readyObjectKey = `ready/${ownerId}/${assetId}/original.webp`;
    const thumbnailObjectKey = `ready/${ownerId}/${assetId}/thumbnail.webp`;
    const uploadExpiresAt = new Date(
      this.now().getTime() + this.config.uploadUrlTtlSeconds * 1_000,
    );
    const attachment = await this.repository.createPendingAttachment({
      id: attachmentId,
      assetId,
      ownerId,
      conversationId,
      originalFileName: input.originalFileName,
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
    const thumbnailObjectKey = requireObjectKey(
      attachment.thumbnailObjectKey,
    );
    const location = {
      bucket: this.config.attachmentBucket,
      key: incomingObjectKey,
    };
    let stored;

    try {
      const metadata = await this.storage.headObject(location);
      this.assertStoredMetadataMatchesIntent(attachment, metadata);
      stored = await this.storage.getObject(location, {
        maxBytes: MAX_ATTACHMENT_BYTES,
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

      await this.repository.releaseProcessing(
        ownerId,
        attachment.assetId,
        now,
      );
      throw new AttachmentStorageUnavailableError(error);
    }

    let processed;

    try {
      processed = await this.imageProcessor.process(stored.body);

      if (processed.detectedContentType !== attachment.declaredContentType) {
        throw new InvalidAttachmentFileError();
      }
    } catch (error: unknown) {
      if (error instanceof InvalidAttachmentFileError) {
        await this.repository.markRejected(ownerId, attachment.assetId);
      }

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
      await this.repository.releaseProcessing(
        ownerId,
        attachment.assetId,
        now,
      );
      throw new AttachmentStorageUnavailableError(error);
    }

    const completion = await this.repository.completeAttachment({
      attachmentId: attachment.id,
      assetId: attachment.assetId,
      ownerId,
      conversationId: attachment.conversationId,
      detectedContentType: processed.detectedContentType,
      actualSize: stored.body.byteLength,
      width: processed.width,
      height: processed.height,
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
      actualSize > MAX_ATTACHMENT_BYTES
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
      stored.contentLength > MAX_ATTACHMENT_BYTES
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
  if (
    attachment.status !== "READY" ||
    attachment.width === null ||
    attachment.height === null ||
    attachment.readyObjectKey === null ||
    attachment.thumbnailObjectKey === null
  ) {
    throw new AttachmentUploadConflictError();
  }

  const basePath =
    `/api/v1/conversations/${attachment.conversationId}` +
    `/attachments/${attachment.id}`;

  return {
    id: attachment.id,
    originalFileName: attachment.originalFileName,
    contentType: "image/webp",
    width: attachment.width,
    height: attachment.height,
    url: `${basePath}/original`,
    thumbnailUrl: `${basePath}/thumbnail`,
  };
}
