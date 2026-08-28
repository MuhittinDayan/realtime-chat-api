import { describe, expect, it } from "vitest";

import type {
  ObjectLocation,
  ObjectStorage,
  PresignPutInput,
  PresignedPutRequest,
  PutStoredObjectInput,
  StoredObject,
  StoredObjectMetadata,
} from "../../infrastructure/storage/index.js";
import type { UserRecord } from "../auth/auth.repository.js";
import { AvatarCleanupService } from "./avatar-cleanup.service.js";
import type {
  AvatarAssetRecord,
  AvatarCleanupCandidate,
  AvatarRepository,
  CompleteAvatarData,
  CreatePendingAvatarData,
} from "./avatar.repository.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function candidate(
  overrides: Partial<AvatarCleanupCandidate> = {},
): AvatarCleanupCandidate {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    status: "READY",
    declaredContentType: "image/png",
    declaredSize: 4,
    incomingObjectKey: "incoming/upload",
    readyObjectKey: "public/avatar.webp",
    publicUrl: "http://storage/public/avatar.webp",
    uploadExpiresAt: NOW,
    updatedAt: NOW,
    isCurrent: false,
    ...overrides,
  };
}

class CleanupRepository implements AvatarRepository {
  candidates: readonly AvatarCleanupCandidate[] = [];
  query: { now: Date; staleBefore: Date; take: number } | null = null;
  cleared: { assetId: string; key: string }[] = [];
  deleted: string[] = [];

  async listCleanupCandidates(now: Date, staleBefore: Date, take: number) {
    this.query = { now, staleBefore, take };
    return this.candidates;
  }

  async clearIncomingObjectKey(assetId: string, key: string) {
    this.cleared.push({ assetId, key });
  }

  async deleteUnreferencedAsset(assetId: string) {
    this.deleted.push(assetId);
    return true;
  }

  async createPendingAvatar(
    _data: CreatePendingAvatarData,
  ): Promise<AvatarAssetRecord | null> {
    return null;
  }
  async findOwnedAvatar(): Promise<AvatarAssetRecord | null> {
    return null;
  }
  async claimForProcessing() {
    return false;
  }
  async releaseProcessing() {}
  async markRejected() {}
  async completeAvatar(_data: CompleteAvatarData): Promise<UserRecord | null> {
    return null;
  }
  async getCurrentUser(): Promise<UserRecord | null> {
    return null;
  }
  async removeCurrentAvatar(): Promise<UserRecord | null> {
    return null;
  }
}

class CleanupStorage implements ObjectStorage {
  deleted: ObjectLocation[] = [];
  async deleteObject(location: ObjectLocation) {
    this.deleted.push(location);
  }
  async presignPut(_input: PresignPutInput): Promise<PresignedPutRequest> {
    throw new Error("not used");
  }
  async headObject(): Promise<StoredObjectMetadata> {
    throw new Error("not used");
  }
  async getObject(): Promise<StoredObject> {
    throw new Error("not used");
  }
  async putObject(_input: PutStoredObjectInput) {
    throw new Error("not used");
  }
}

describe("avatar cleanup service", () => {
  it("removes both objects and the database row for an unreferenced avatar", async () => {
    const repository = new CleanupRepository();
    const storage = new CleanupStorage();
    repository.candidates = [candidate()];
    const service = new AvatarCleanupService(
      repository,
      storage,
      { avatarBucket: "avatars", staleUploadAgeMs: 3_600_000 },
      () => NOW,
    );

    const result = await service.runOnce();

    expect(storage.deleted).toEqual([
      { bucket: "avatars", key: "incoming/upload" },
      { bucket: "avatars", key: "public/avatar.webp" },
    ]);
    expect(repository.deleted).toEqual([repository.candidates[0]?.id]);
    expect(result).toEqual({
      inspected: 1,
      deletedAssets: 1,
      clearedIncomingObjects: 1,
    });
    expect(repository.query?.staleBefore).toEqual(
      new Date(NOW.getTime() - 3_600_000),
    );
  });

  it("only clears the private source object for the current avatar", async () => {
    const repository = new CleanupRepository();
    const storage = new CleanupStorage();
    repository.candidates = [candidate({ isCurrent: true })];
    const service = new AvatarCleanupService(
      repository,
      storage,
      { avatarBucket: "avatars", staleUploadAgeMs: 3_600_000 },
      () => NOW,
    );

    await service.runOnce();

    expect(storage.deleted).toEqual([
      { bucket: "avatars", key: "incoming/upload" },
    ]);
    expect(repository.deleted).toEqual([]);
  });
});
