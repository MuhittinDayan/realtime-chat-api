import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { UserRecord } from "../auth/persistence/auth.repository.js";
import type { AvatarContentType } from "./avatar.constants.js";

export type AvatarAssetStatus =
  | "PENDING"
  | "PROCESSING"
  | "READY"
  | "REJECTED"
  | "CANCELLED";

export interface AvatarAssetRecord {
  id: string;
  ownerId: string;
  status: AvatarAssetStatus;
  declaredContentType: string;
  declaredSize: number;
  incomingObjectKey: string | null;
  readyObjectKey: string | null;
  publicUrl: string | null;
  uploadExpiresAt: Date;
  updatedAt: Date;
  isCurrent: boolean;
}

export interface CreatePendingAvatarData {
  id: string;
  ownerId: string;
  declaredContentType: AvatarContentType;
  declaredSize: number;
  incomingObjectKey: string;
  readyObjectKey: string;
  publicUrl: string;
  uploadExpiresAt: Date;
}

export interface CompleteAvatarData {
  assetId: string;
  ownerId: string;
  detectedContentType: string;
  actualSize: number;
  width: number;
  height: number;
  readyAt: Date;
}

export interface AvatarCleanupCandidate extends AvatarAssetRecord {}

export interface AvatarRepository {
  createPendingAvatar(
    data: CreatePendingAvatarData,
  ): Promise<AvatarAssetRecord | null>;
  findOwnedAvatar(
    ownerId: string,
    assetId: string,
  ): Promise<AvatarAssetRecord | null>;
  claimForProcessing(
    ownerId: string,
    assetId: string,
    now: Date,
  ): Promise<boolean>;
  releaseProcessing(ownerId: string, assetId: string, now: Date): Promise<void>;
  markRejected(ownerId: string, assetId: string): Promise<void>;
  completeAvatar(data: CompleteAvatarData): Promise<UserRecord | null>;
  getCurrentUser(ownerId: string): Promise<UserRecord | null>;
  removeCurrentAvatar(ownerId: string): Promise<UserRecord | null>;
  listCleanupCandidates(
    now: Date,
    staleBefore: Date,
    take: number,
  ): Promise<readonly AvatarCleanupCandidate[]>;
  clearIncomingObjectKey(assetId: string, objectKey: string): Promise<void>;
  deleteUnreferencedAsset(assetId: string): Promise<boolean>;
}

const userSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  status: true,
  createdAt: true,
  deletedAt: true,
} as const;

const avatarSelect = {
  id: true,
  ownerId: true,
  status: true,
  declaredContentType: true,
  declaredSize: true,
  incomingObjectKey: true,
  readyObjectKey: true,
  publicUrl: true,
  uploadExpiresAt: true,
  updatedAt: true,
  avatarFor: { select: { id: true } },
} as const;

type SelectedAvatar = Prisma.MediaAssetGetPayload<{
  select: typeof avatarSelect;
}>;

function toAvatarAsset(record: SelectedAvatar): AvatarAssetRecord {
  return {
    id: record.id,
    ownerId: record.ownerId,
    status: record.status,
    declaredContentType: record.declaredContentType,
    declaredSize: record.declaredSize,
    incomingObjectKey: record.incomingObjectKey,
    readyObjectKey: record.readyObjectKey,
    publicUrl: record.publicUrl,
    uploadExpiresAt: record.uploadExpiresAt,
    updatedAt: record.updatedAt,
    isCurrent: record.avatarFor !== null,
  };
}

export class PrismaAvatarRepository implements AvatarRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async createPendingAvatar(
    data: CreatePendingAvatarData,
  ): Promise<AvatarAssetRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const user = await transaction.user.findFirst({
        where: { id: data.ownerId, status: "ACTIVE", deletedAt: null },
        select: { id: true },
      });

      if (user === null) {
        return null;
      }

      await transaction.mediaAsset.updateMany({
        where: {
          ownerId: data.ownerId,
          purpose: "AVATAR",
          status: "PENDING",
        },
        data: { status: "CANCELLED" },
      });
      const created = await transaction.mediaAsset.create({
        data: {
          id: data.id,
          ownerId: data.ownerId,
          purpose: "AVATAR",
          status: "PENDING",
          declaredContentType: data.declaredContentType,
          declaredSize: data.declaredSize,
          incomingObjectKey: data.incomingObjectKey,
          readyObjectKey: data.readyObjectKey,
          publicUrl: data.publicUrl,
          uploadExpiresAt: data.uploadExpiresAt,
        },
        select: avatarSelect,
      });

      return toAvatarAsset(created);
    });
  }

  async findOwnedAvatar(
    ownerId: string,
    assetId: string,
  ): Promise<AvatarAssetRecord | null> {
    const record = await this.client.mediaAsset.findFirst({
      where: { id: assetId, ownerId, purpose: "AVATAR" },
      select: avatarSelect,
    });

    return record === null ? null : toAvatarAsset(record);
  }

  async claimForProcessing(
    ownerId: string,
    assetId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        ownerId,
        purpose: "AVATAR",
        status: "PENDING",
        uploadExpiresAt: { gt: now },
      },
      data: { status: "PROCESSING" },
    });

    return result.count === 1;
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
        status: "PROCESSING",
        uploadExpiresAt: { gt: now },
      },
      data: { status: "PENDING" },
    });
  }

  async markRejected(ownerId: string, assetId: string): Promise<void> {
    await this.client.mediaAsset.updateMany({
      where: {
        id: assetId,
        ownerId,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      data: { status: "REJECTED" },
    });
  }

  async completeAvatar(data: CompleteAvatarData): Promise<UserRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const updatedAsset = await transaction.mediaAsset.updateMany({
        where: {
          id: data.assetId,
          ownerId: data.ownerId,
          purpose: "AVATAR",
          status: "PROCESSING",
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

      if (updatedAsset.count !== 1) {
        throw new AvatarTransactionConflict();
      }

      const asset = await transaction.mediaAsset.findUniqueOrThrow({
        where: { id: data.assetId },
        select: { publicUrl: true },
      });
      const updatedUser = await transaction.user.updateMany({
        where: {
          id: data.ownerId,
          status: "ACTIVE",
          deletedAt: null,
        },
        data: {
          avatarAssetId: data.assetId,
          avatarUrl: asset.publicUrl,
        },
      });

      if (updatedUser.count !== 1) {
        throw new AvatarTransactionConflict();
      }

      return transaction.user.findUnique({
        where: { id: data.ownerId },
        select: userSelect,
      });
    }).catch((error: unknown) => {
      if (error instanceof AvatarTransactionConflict) {
        return null;
      }

      throw error;
    });
  }

  async getCurrentUser(ownerId: string): Promise<UserRecord | null> {
    return this.client.user.findFirst({
      where: { id: ownerId, status: "ACTIVE", deletedAt: null },
      select: userSelect,
    });
  }

  async removeCurrentAvatar(ownerId: string): Promise<UserRecord | null> {
    const user = await this.client.user.findFirst({
      where: { id: ownerId, status: "ACTIVE", deletedAt: null },
      select: { id: true },
    });

    if (user === null) {
      return null;
    }

    return this.client.user.update({
      where: { id: ownerId },
      data: { avatarAssetId: null, avatarUrl: null },
      select: userSelect,
    });
  }

  async listCleanupCandidates(
    now: Date,
    staleBefore: Date,
    take: number,
  ): Promise<readonly AvatarCleanupCandidate[]> {
    const records = await this.client.mediaAsset.findMany({
      where: {
        purpose: "AVATAR",
        OR: [
          {
            status: "PENDING",
            uploadExpiresAt: { lte: now },
            updatedAt: { lte: staleBefore },
          },
          {
            status: { in: ["PROCESSING", "REJECTED", "CANCELLED"] },
            updatedAt: { lte: staleBefore },
          },
          { status: "READY", avatarFor: null },
          {
            status: "READY",
            incomingObjectKey: { not: null },
          },
        ],
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take,
      select: avatarSelect,
    });

    return records.map(toAvatarAsset);
  }

  async clearIncomingObjectKey(
    assetId: string,
    objectKey: string,
  ): Promise<void> {
    await this.client.mediaAsset.updateMany({
      where: { id: assetId, incomingObjectKey: objectKey },
      data: { incomingObjectKey: null },
    });
  }

  async deleteUnreferencedAsset(assetId: string): Promise<boolean> {
    const result = await this.client.mediaAsset.deleteMany({
      where: { id: assetId, avatarFor: null },
    });

    return result.count === 1;
  }
}

class AvatarTransactionConflict extends Error {}
