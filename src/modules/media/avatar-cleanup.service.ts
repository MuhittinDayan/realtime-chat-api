import type { ObjectStorage } from "../../infrastructure/storage/index.js";
import type {
  AvatarCleanupCandidate,
  AvatarRepository,
} from "./avatar.repository.js";

export interface AvatarCleanupConfig {
  avatarBucket: string;
  staleUploadAgeMs: number;
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

    return {
      inspected: candidates.length,
      deletedAssets,
      clearedIncomingObjects,
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
