import type { ObjectStorage } from "../../infrastructure/storage/index.js";
import type {
  AvatarCleanupCandidate,
  AvatarRepository,
} from "./avatar.repository.js";
import type {
  AttachmentCleanupCandidate,
  AttachmentRepository,
} from "../attachments/attachment.repository.js";

export interface AvatarCleanupConfig {
  avatarBucket: string;
  staleUploadAgeMs: number;
  attachmentBucket?: string;
  unboundAttachmentAgeMs?: number;
  batchSize?: number;
}

export interface AvatarCleanupResult {
  inspected: number;
  deletedAssets: number;
  clearedIncomingObjects: number;
}

export class AvatarCleanupService {
  constructor(
    private readonly repository: AvatarRepository,
    private readonly storage: ObjectStorage,
    private readonly config: AvatarCleanupConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly attachmentRepository?: AttachmentRepository,
  ) {}

  async runOnce(): Promise<AvatarCleanupResult> {
    const now = this.now();
    const candidates = await this.repository.listCleanupCandidates(
      now,
      new Date(now.getTime() - this.config.staleUploadAgeMs),
      this.config.batchSize ?? 100,
    );
    let deletedAssets = 0;
    let clearedIncomingObjects = 0;

    for (const candidate of candidates) {
      const result = await this.cleanupCandidate(candidate);
      deletedAssets += result.deletedAssets;
      clearedIncomingObjects += result.clearedIncomingObjects;
    }

    const attachmentCandidates = await this.listAttachmentCandidates(now);

    for (const candidate of attachmentCandidates) {
      const result = await this.cleanupAttachmentCandidate(candidate);
      deletedAssets += result.deletedAssets;
      clearedIncomingObjects += result.clearedIncomingObjects;
    }

    return {
      inspected: candidates.length + attachmentCandidates.length,
      deletedAssets,
      clearedIncomingObjects,
    };
  }

  private async listAttachmentCandidates(
    now: Date,
  ): Promise<readonly AttachmentCleanupCandidate[]> {
    if (
      this.attachmentRepository === undefined ||
      this.config.attachmentBucket === undefined ||
      this.config.unboundAttachmentAgeMs === undefined
    ) {
      return [];
    }

    const staleBefore = new Date(
      now.getTime() - this.config.staleUploadAgeMs,
    );
    await this.attachmentRepository.resetStaleProcessing(staleBefore);

    return this.attachmentRepository.listCleanupCandidates(
      now,
      new Date(now.getTime() - this.config.unboundAttachmentAgeMs),
      staleBefore,
      this.config.batchSize ?? 100,
    );
  }

  private async cleanupAttachmentCandidate(
    candidate: AttachmentCleanupCandidate,
  ): Promise<Pick<
    AvatarCleanupResult,
    "deletedAssets" | "clearedIncomingObjects"
  >> {
    if (
      this.attachmentRepository === undefined ||
      this.config.attachmentBucket === undefined
    ) {
      return { deletedAssets: 0, clearedIncomingObjects: 0 };
    }

    const keys = new Set(
      [
        candidate.incomingObjectKey,
        candidate.readyObjectKey,
        candidate.thumbnailObjectKey,
      ].filter((key): key is string => key !== null),
    );

    for (const key of keys) {
      await this.storage.deleteObject({
        bucket: this.config.attachmentBucket,
        key,
      });
    }

    const deleted = await this.attachmentRepository.deleteAsset(
      candidate.assetId,
    );

    return {
      deletedAssets: deleted ? 1 : 0,
      clearedIncomingObjects: candidate.incomingObjectKey === null ? 0 : 1,
    };
  }

  private async cleanupCandidate(
    candidate: AvatarCleanupCandidate,
  ): Promise<Pick<
    AvatarCleanupResult,
    "deletedAssets" | "clearedIncomingObjects"
  >> {
    let clearedIncomingObjects = 0;

    if (candidate.incomingObjectKey !== null) {
      await this.storage.deleteObject({
        bucket: this.config.avatarBucket,
        key: candidate.incomingObjectKey,
      });
      await this.repository.clearIncomingObjectKey(
        candidate.id,
        candidate.incomingObjectKey,
      );
      clearedIncomingObjects = 1;
    }

    if (candidate.isCurrent) {
      return { deletedAssets: 0, clearedIncomingObjects };
    }

    if (candidate.readyObjectKey !== null) {
      await this.storage.deleteObject({
        bucket: this.config.avatarBucket,
        key: candidate.readyObjectKey,
      });
    }

    const deleted = await this.repository.deleteUnreferencedAsset(candidate.id);

    return {
      deletedAssets: deleted ? 1 : 0,
      clearedIncomingObjects,
    };
  }
}
