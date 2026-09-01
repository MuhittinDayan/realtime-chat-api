import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type {
  AttachmentContentType,
  AttachmentKind,
} from "./attachment.constants.js";

export type AttachmentAssetStatus =
  | "PENDING"
  | "PROCESSING"
  | "READY"
  | "REJECTED"
  | "CANCELLED";

export interface AttachmentRecord {
  id: string;
  assetId: string;
  ownerId: string;
  conversationId: string;
  messageId: string | null;
  originalFileName: string;
  kind: AttachmentKind;
  position: number;
  thumbnailObjectKey: string | null;
  purgeAfter: Date | null;
  status: AttachmentAssetStatus;
  declaredContentType: string;
  declaredSize: number;
  detectedContentType: string | null;
  actualSize: number | null;
  width: number | null;
  height: number | null;
  incomingObjectKey: string | null;
  readyObjectKey: string | null;
  uploadExpiresAt: Date;
  readyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttachmentCleanupCandidate extends AttachmentRecord {}

export interface CreatePendingAttachmentData {
  id: string;
  assetId: string;
  ownerId: string;
  conversationId: string;
  originalFileName: string;
  kind: AttachmentKind;
  declaredContentType: AttachmentContentType;
  declaredSize: number;
  incomingObjectKey: string;
  readyObjectKey: string;
  thumbnailObjectKey: string | null;
  uploadExpiresAt: Date;
}

export interface CompleteAttachmentData {
  attachmentId: string;
  assetId: string;
  ownerId: string;
  conversationId: string;
  detectedContentType: AttachmentContentType;
  actualSize: number;
  width: number | null;
  height: number | null;
  readyAt: Date;
}

export type CompleteAttachmentResult =
  | "COMPLETED"
  | "CONVERSATION_NOT_FOUND"
  | "CONFLICT";

export type AttachmentClaimResult =
  | "CLAIMED"
  | "CONVERSATION_NOT_FOUND"
  | "CONFLICT";

export interface AttachmentRepository {
  createPendingAttachment(
    data: CreatePendingAttachmentData,
  ): Promise<AttachmentRecord | null>;
  findOwnedAttachment(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;
  claimForProcessing(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
    now: Date,
  ): Promise<AttachmentClaimResult>;
  releaseProcessing(ownerId: string, assetId: string, now: Date): Promise<void>;
  releaseProcessingForRetry(ownerId: string, assetId: string): Promise<boolean>;
  markRejected(ownerId: string, assetId: string): Promise<void>;
  completeAttachment(
    data: CompleteAttachmentData,
  ): Promise<CompleteAttachmentResult>;
  clearIncomingObjectKey(assetId: string, objectKey: string): Promise<void>;
  findAccessibleAttachment(
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null>;
  listCleanupCandidates(
    now: Date,
    unboundReadyBefore: Date,
    staleBefore: Date,
    take: number,
  ): Promise<readonly AttachmentCleanupCandidate[]>;
  resetStaleProcessing(staleBefore: Date): Promise<number>;
  deleteAsset(assetId: string): Promise<boolean>;
}

const attachmentSelect = {
  id: true,
  assetId: true,
  conversationId: true,
  messageId: true,
  originalFileName: true,
  kind: true,
  position: true,
  thumbnailObjectKey: true,
  purgeAfter: true,
  createdAt: true,
  updatedAt: true,
  asset: {
    select: {
      ownerId: true,
      status: true,
      declaredContentType: true,
      declaredSize: true,
      detectedContentType: true,
      actualSize: true,
      width: true,
      height: true,
      incomingObjectKey: true,
      readyObjectKey: true,
      uploadExpiresAt: true,
      readyAt: true,
    },
  },
} as const;

type SelectedAttachment = Prisma.MessageAttachmentGetPayload<{
  select: typeof attachmentSelect;
}>;

function toAttachmentRecord(record: SelectedAttachment): AttachmentRecord {
  return {
    id: record.id,
    assetId: record.assetId,
    ownerId: record.asset.ownerId,
    conversationId: record.conversationId,
    messageId: record.messageId,
    originalFileName: record.originalFileName,
    kind: record.kind,
    position: record.position,
    thumbnailObjectKey: record.thumbnailObjectKey,
    purgeAfter: record.purgeAfter,
    status: record.asset.status,
    declaredContentType: record.asset.declaredContentType,
    declaredSize: record.asset.declaredSize,
    detectedContentType: record.asset.detectedContentType,
    actualSize: record.asset.actualSize,
    width: record.asset.width,
    height: record.asset.height,
    incomingObjectKey: record.asset.incomingObjectKey,
    readyObjectKey: record.asset.readyObjectKey,
    uploadExpiresAt: record.asset.uploadExpiresAt,
    readyAt: record.asset.readyAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function hasActiveMembership(
  transaction: Prisma.TransactionClient,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const membership = await transaction.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { leftAt: true },
  });

  return membership !== null && membership.leftAt === null;
}

export class PrismaAttachmentRepository implements AttachmentRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async createPendingAttachment(
    data: CreatePendingAttachmentData,
  ): Promise<AttachmentRecord | null> {
    return this.client.$transaction(async (transaction) => {
      if (
        !(await hasActiveMembership(
          transaction,
          data.conversationId,
          data.ownerId,
        ))
      ) {
        return null;
      }

      await transaction.mediaAsset.create({
        data: {
          id: data.assetId,
          ownerId: data.ownerId,
          purpose: "MESSAGE_ATTACHMENT",
          status: "PENDING",
          declaredContentType: data.declaredContentType,
          declaredSize: data.declaredSize,
          incomingObjectKey: data.incomingObjectKey,
          readyObjectKey: data.readyObjectKey,
          uploadExpiresAt: data.uploadExpiresAt,
        },
      });
      const attachment = await transaction.messageAttachment.create({
        data: {
          id: data.id,
          assetId: data.assetId,
          conversationId: data.conversationId,
          originalFileName: data.originalFileName,
          kind: data.kind,
          thumbnailObjectKey: data.thumbnailObjectKey,
        },
        select: attachmentSelect,
      });

      return toAttachmentRecord(attachment);
    });
  }

  async findOwnedAttachment(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null> {
    const attachment = await this.client.messageAttachment.findFirst({
      where: {
        id: attachmentId,
        conversationId,
        asset: { ownerId, purpose: "MESSAGE_ATTACHMENT" },
      },
      select: attachmentSelect,
    });

    return attachment === null ? null : toAttachmentRecord(attachment);
  }

  async claimForProcessing(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
    now: Date,
  ): Promise<AttachmentClaimResult> {
    return this.client.$transaction(async (transaction) => {
      if (
        !(await hasActiveMembership(transaction, conversationId, ownerId))
      ) {
        return "CONVERSATION_NOT_FOUND";
      }

      const attachment = await transaction.messageAttachment.findFirst({
        where: {
          id: attachmentId,
          conversationId,
          asset: { ownerId, purpose: "MESSAGE_ATTACHMENT" },
        },
        select: { assetId: true },
      });

      if (attachment === null) {
        return "CONFLICT";
      }

      const claimed = await transaction.mediaAsset.updateMany({
        where: {
          id: attachment.assetId,
          ownerId,
          purpose: "MESSAGE_ATTACHMENT",
          status: "PENDING",
          uploadExpiresAt: { gt: now },
        },
        data: { status: "PROCESSING" },
      });

      return claimed.count === 1 ? "CLAIMED" : "CONFLICT";
    });
  }

  async releaseProcessing(
    ownerId: string,
    assetId: string,
    now: Date,
  ): Promise<void> {
    await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        ownerId,
        purpose: "MESSAGE_ATTACHMENT",
        status: "PROCESSING",
        uploadExpiresAt: { gt: now },
      },
      data: { status: "PENDING" },
    });
  }

  async releaseProcessingForRetry(
    ownerId: string,
    assetId: string,
  ): Promise<boolean> {
    const released = await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        ownerId,
        purpose: "MESSAGE_ATTACHMENT",
        status: "PROCESSING",
      },
      data: { status: "PENDING" },
    });

    return released.count === 1;
  }

  async markRejected(ownerId: string, assetId: string): Promise<void> {
    await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        ownerId,
        purpose: "MESSAGE_ATTACHMENT",
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "REJECTED" },
    });
  }

  async completeAttachment(
    data: CompleteAttachmentData,
  ): Promise<CompleteAttachmentResult> {
    return this.client.$transaction(async (transaction) => {
      if (
        !(await hasActiveMembership(
          transaction,
          data.conversationId,
          data.ownerId,
        ))
      ) {
        return "CONVERSATION_NOT_FOUND";
      }

      const result = await transaction.mediaAsset.updateMany({
        where: {
          id: data.assetId,
          ownerId: data.ownerId,
          purpose: "MESSAGE_ATTACHMENT",
          status: "PROCESSING",
          messageAttachment: {
            id: data.attachmentId,
            conversationId: data.conversationId,
          },
        },
        data: {
          status: "READY",
          detectedContentType: data.detectedContentType,
          actualSize: data.actualSize,
          width: data.width,
          height: data.height,
          readyAt: data.readyAt,
        },
      });

      return result.count === 1 ? "COMPLETED" : "CONFLICT";
    });
  }

  async clearIncomingObjectKey(
    assetId: string,
    objectKey: string,
  ): Promise<void> {
    await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        purpose: "MESSAGE_ATTACHMENT",
        incomingObjectKey: objectKey,
      },
      data: { incomingObjectKey: null },
    });
  }

  async findAccessibleAttachment(
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentRecord | null> {
    const attachment = await this.client.messageAttachment.findFirst({
      where: {
        id: attachmentId,
        conversationId,
        asset: { purpose: "MESSAGE_ATTACHMENT", status: "READY" },
        message: { is: { deletedAt: null } },
      },
      select: attachmentSelect,
    });

    return attachment === null ? null : toAttachmentRecord(attachment);
  }

  async listCleanupCandidates(
    now: Date,
    unboundReadyBefore: Date,
    staleBefore: Date,
    take: number,
  ): Promise<readonly AttachmentCleanupCandidate[]> {
    const attachments = await this.client.messageAttachment.findMany({
      where: {
        asset: { purpose: "MESSAGE_ATTACHMENT" },
        OR: [
          {
            messageId: null,
            updatedAt: { lte: unboundReadyBefore },
            asset: { purpose: "MESSAGE_ATTACHMENT", status: "READY" },
          },
          {
            messageId: null,
            asset: {
              purpose: "MESSAGE_ATTACHMENT",
              status: "PENDING",
              uploadExpiresAt: { lte: staleBefore },
            },
          },
          {
            messageId: null,
            updatedAt: { lte: staleBefore },
            asset: {
              purpose: "MESSAGE_ATTACHMENT",
              status: { in: ["REJECTED", "CANCELLED"] },
            },
          },
          { purgeAfter: { lte: now } },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
      select: attachmentSelect,
    });

    return attachments.map(toAttachmentRecord);
  }

  async resetStaleProcessing(staleBefore: Date): Promise<number> {
    const reset = await this.client.mediaAsset.updateMany({
      where: {
        purpose: "MESSAGE_ATTACHMENT",
        status: "PROCESSING",
        updatedAt: { lte: staleBefore },
      },
      data: { status: "PENDING" },
    });

    return reset.count;
  }

  async deleteAsset(assetId: string): Promise<boolean> {
    const deleted = await this.client.mediaAsset.deleteMany({
      where: { id: assetId, purpose: "MESSAGE_ATTACHMENT" },
    });

    return deleted.count === 1;
  }
}
