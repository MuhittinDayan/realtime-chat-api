import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  objectStorage,
  storageBuckets,
  storageSettings,
} from "../../infrastructure/storage/index.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { AvatarCleanupService } from "./avatar-cleanup.service.js";
import { SharpAvatarImageProcessor } from "./avatar-image.processor.js";
import { PrismaAvatarRepository } from "./avatar.repository.js";
import { AvatarService } from "./avatar.service.js";

const USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UPLOAD_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const incomingKey = `incoming/${UPLOAD_ID}`;
const readyKey = `public/${UPLOAD_ID}.webp`;

async function cleanFixture(): Promise<void> {
  await prisma.user.updateMany({
    where: { id: USER_ID },
    data: { avatarAssetId: null, avatarUrl: null },
  });
  await prisma.mediaAsset.deleteMany({ where: { ownerId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
  await objectStorage.deleteObject({ bucket: storageBuckets.avatar, key: incomingKey });
  await objectStorage.deleteObject({ bucket: storageBuckets.avatar, key: readyKey });
}

beforeEach(async () => {
  await cleanFixture();
  await prisma.user.create({
    data: {
      id: USER_ID,
      email: "phase14a-storage@example.com",
      username: "phase14a-storage",
      displayName: "Phase 14a Storage",
      passwordHash: "not-used",
    },
  });
});

afterEach(cleanFixture);

describe("phase 14a real object-storage behavior", () => {
  it("processes a private source into a public WebP and later cleans both objects", async () => {
    const source = await sharp({
      create: {
        width: 640,
        height: 480,
        channels: 3,
        background: "blue",
      },
    })
      .png()
      .toBuffer();
    const repository = new PrismaAvatarRepository(prisma);
    const service = new AvatarService(
      repository,
      objectStorage,
      new SharpAvatarImageProcessor(),
      {
        avatarBucket: storageBuckets.avatar,
        publicAvatarBaseUrl: storageSettings.publicAvatarBaseUrl,
        uploadUrlTtlSeconds: storageSettings.avatarUploadUrlTtlSeconds,
        cacheControl: storageSettings.avatarCacheControl,
      },
      { notifyProfileUpdated: async () => undefined },
      () => NOW,
      () => UPLOAD_ID,
    );

    const intent = await service.createUpload(USER_ID, {
      contentType: "image/png",
      contentLength: source.byteLength,
    });
    await objectStorage.putObject({
      bucket: storageBuckets.avatar,
      key: incomingKey,
      body: source,
      contentType: "image/png",
    });
    const user = await service.completeUpload(USER_ID, intent.uploadId);
    const publicResponse = await fetch(user.avatarUrl ?? "");
    const outputMetadata = await sharp(
      new Uint8Array(await publicResponse.arrayBuffer()),
    ).metadata();

    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("cache-control")).toBe(
      storageSettings.avatarCacheControl,
    );
    expect(outputMetadata).toEqual(
      expect.objectContaining({ format: "webp", width: 512, height: 512 }),
    );

    const cleanup = new AvatarCleanupService(
      repository,
      objectStorage,
      {
        avatarBucket: storageBuckets.avatar,
        staleUploadAgeMs: storageSettings.staleUploadAgeMs,
      },
      () => NOW,
    );
    await cleanup.runOnce();
    await service.deleteAvatar(USER_ID);
    await cleanup.runOnce();

    expect(await prisma.mediaAsset.findUnique({ where: { id: UPLOAD_ID } })).toBeNull();
    expect((await fetch(user.avatarUrl ?? "")).status).toBe(404);
  });
});
