import { randomUUID } from "node:crypto";

import {
  buildPublicObjectUrl,
  StorageObjectNotFoundError,
  StorageObjectTooLargeError,
  type ObjectStorage,
} from "../../infrastructure/storage/index.js";
import { InvalidTokenError } from "../auth/auth.errors.js";
import type { UserRecord } from "../auth/auth.repository.js";
import type { CurrentUserProfile } from "../users/users.service.js";
import {
  isAvatarContentType,
  MAX_AVATAR_BYTES,
} from "./avatar.constants.js";
import {
  AvatarStorageUnavailableError,
  AvatarUploadConflictError,
  AvatarUploadExpiredError,
  AvatarUploadIncompleteError,
  AvatarUploadNotFoundError,
  InvalidAvatarFileError,
  UnsupportedAvatarFormatError,
} from "./avatar.errors.js";
import type { AvatarImageProcessor } from "./avatar-image.processor.js";
import type {
  AvatarAssetRecord,
  AvatarRepository,
} from "./avatar.repository.js";

export interface AvatarServiceConfig {
  avatarBucket: string;
  publicAvatarBaseUrl: string;
  uploadUrlTtlSeconds: number;
  cacheControl: string;
}

export interface CreateAvatarUploadInput {
  contentType: string;
  contentLength: number;
}

export interface AvatarUploadIntent {
  uploadId: string;
  upload: {
    url: string;
    method: "PUT";
    headers: Readonly<Record<string, string>>;
    expiresAt: Date;
  };
}

export class AvatarService {
  constructor(
    private readonly repository: AvatarRepository,
    private readonly storage: ObjectStorage,
    private readonly imageProcessor: AvatarImageProcessor,
    private readonly config: AvatarServiceConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async createUpload(
    ownerId: string,
    input: CreateAvatarUploadInput,
  ): Promise<AvatarUploadIntent> {
    if (!isAvatarContentType(input.contentType)) {
      throw new UnsupportedAvatarFormatError();
    }

    const uploadId = this.createId();
    const incomingObjectKey = `incoming/${uploadId}`;
    const readyObjectKey = `public/${uploadId}.webp`;
    const publicUrl = buildPublicObjectUrl(
      this.config.publicAvatarBaseUrl,
      readyObjectKey,
    );
    const uploadExpiresAt = new Date(
      this.now().getTime() + this.config.uploadUrlTtlSeconds * 1_000,
    );
    const asset = await this.repository.createPendingAvatar({
      id: uploadId,
      ownerId,
      declaredContentType: input.contentType,
      declaredSize: input.contentLength,
      incomingObjectKey,
      readyObjectKey,
      publicUrl,
      uploadExpiresAt,
    });

    if (asset === null) {
      throw new InvalidTokenError();
    }

    try {
      const upload = await this.storage.presignPut({
        bucket: this.config.avatarBucket,
        key: incomingObjectKey,
        contentType: input.contentType,
        expiresInSeconds: this.config.uploadUrlTtlSeconds,
      });

      return { uploadId, upload };
    } catch (error: unknown) {
      throw new AvatarStorageUnavailableError(error);
    }
  }

  async completeUpload(
    ownerId: string,
    uploadId: string,
  ): Promise<CurrentUserProfile> {
    const initial = await this.repository.findOwnedAvatar(ownerId, uploadId);

    if (initial === null) {
      throw new AvatarUploadNotFoundError();
    }

    const idempotentUser = await this.resolveCompletedRetry(ownerId, initial);

    if (idempotentUser !== null) {
      return idempotentUser;
    }

    const now = this.now();
    this.assertPendingAndCurrent(initial, now);

    if (!(await this.repository.claimForProcessing(ownerId, uploadId, now))) {
      const latest = await this.repository.findOwnedAvatar(ownerId, uploadId);
      const retryUser =
        latest === null
          ? null
          : await this.resolveCompletedRetry(ownerId, latest);

      if (retryUser !== null) {
        return retryUser;
      }

      throw new AvatarUploadConflictError();
    }

    return this.processClaimedUpload(ownerId, initial, now);
  }

  async deleteAvatar(ownerId: string): Promise<CurrentUserProfile> {
    const user = await this.repository.removeCurrentAvatar(ownerId);

    if (user === null || user.status !== "ACTIVE" || user.deletedAt !== null) {
      throw new InvalidTokenError();
    }

    return toCurrentUserProfile(user);
  }

  private async resolveCompletedRetry(
    ownerId: string,
    asset: AvatarAssetRecord,
  ): Promise<CurrentUserProfile | null> {
    if (asset.status !== "READY" || !asset.isCurrent) {
      return null;
    }

    const user = await this.repository.getCurrentUser(ownerId);

    if (user === null) {
      throw new InvalidTokenError();
    }

    return toCurrentUserProfile(user);
  }

  private assertPendingAndCurrent(
    asset: AvatarAssetRecord,
    now: Date,
  ): void {
    if (asset.status !== "PENDING") {
      throw new AvatarUploadConflictError();
    }

    if (asset.uploadExpiresAt.getTime() <= now.getTime()) {
      throw new AvatarUploadExpiredError();
    }
  }

  private async processClaimedUpload(
    ownerId: string,
    asset: AvatarAssetRecord,
    now: Date,
  ): Promise<CurrentUserProfile> {
    const incomingObjectKey = requireObjectKey(asset.incomingObjectKey);
    const readyObjectKey = requireObjectKey(asset.readyObjectKey);
    const location = {
      bucket: this.config.avatarBucket,
      key: incomingObjectKey,
    };
    let stored;

    try {
      const metadata = await this.storage.headObject(location);
      this.assertStoredMetadataMatchesIntent(asset, metadata);
      stored = await this.storage.getObject(location, {
        maxBytes: MAX_AVATAR_BYTES,
      });
      this.assertStoredObjectMatchesIntent(asset, stored);
    } catch (error: unknown) {
      if (error instanceof InvalidAvatarFileError) {
        await this.repository.markRejected(ownerId, asset.id);
        throw error;
      }

      if (error instanceof StorageObjectTooLargeError) {
        await this.repository.markRejected(ownerId, asset.id);
        throw new InvalidAvatarFileError(error);
      }

      if (error instanceof StorageObjectNotFoundError) {
        await this.repository.releaseProcessing(ownerId, asset.id, now);
        throw new AvatarUploadIncompleteError();
      }

      await this.repository.releaseProcessing(ownerId, asset.id, now);
      throw new AvatarStorageUnavailableError(error);
    }

    let processed;

    try {
      processed = await this.imageProcessor.process(stored.body);
    } catch (error: unknown) {
      if (error instanceof InvalidAvatarFileError) {
        await this.repository.markRejected(ownerId, asset.id);
      }

      throw error;
    }

    try {
      await this.storage.putObject({
        bucket: this.config.avatarBucket,
        key: readyObjectKey,
        body: processed.body,
        contentType: "image/webp",
        cacheControl: this.config.cacheControl,
      });
    } catch (error: unknown) {
      await this.repository.releaseProcessing(ownerId, asset.id, now);
      throw new AvatarStorageUnavailableError(error);
    }

    const user = await this.repository.completeAvatar({
      assetId: asset.id,
      ownerId,
      detectedContentType: processed.detectedContentType,
      actualSize: stored.body.byteLength,
      width: processed.width,
      height: processed.height,
      readyAt: this.now(),
    });

    if (user === null) {
      throw new AvatarUploadConflictError();
    }

    return toCurrentUserProfile(user);
  }

  private assertStoredObjectMatchesIntent(
    asset: AvatarAssetRecord,
    stored: {
      body: Uint8Array;
      contentLength: number | undefined;
      contentType: string | undefined;
    },
  ): void {
    this.assertStoredMetadataMatchesIntent(asset, stored);
    const actualSize = stored.body.byteLength;

    if (
      stored.contentLength !== actualSize ||
      actualSize !== asset.declaredSize ||
      actualSize > MAX_AVATAR_BYTES
    ) {
      throw new InvalidAvatarFileError();
    }
  }

  private assertStoredMetadataMatchesIntent(
    asset: AvatarAssetRecord,
    stored: {
      contentLength: number | undefined;
      contentType: string | undefined;
    },
  ): void {
    const contentType = stored.contentType?.split(";", 1)[0]?.trim().toLowerCase();

    if (
      contentType !== asset.declaredContentType ||
      stored.contentLength !== asset.declaredSize ||
      stored.contentLength > MAX_AVATAR_BYTES
    ) {
      throw new InvalidAvatarFileError();
    }
  }
}

function requireObjectKey(value: string | null): string {
  if (value === null) {
    throw new AvatarUploadConflictError();
  }

  return value;
}

function toCurrentUserProfile(user: UserRecord): CurrentUserProfile {
  if (user.status !== "ACTIVE" || user.deletedAt !== null) {
    throw new InvalidTokenError();
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    createdAt: user.createdAt,
  };
}
