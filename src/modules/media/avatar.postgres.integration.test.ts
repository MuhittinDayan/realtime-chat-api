import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/database/prisma.js";
import { PrismaAvatarRepository } from "./avatar.repository.js";

const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FIRST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const repository = new PrismaAvatarRepository(prisma);

async function cleanFixture(): Promise<void> {
  await prisma.user.updateMany({
    where: { id: USER_ID },
    data: { avatarAssetId: null, avatarUrl: null },
  });
  await prisma.mediaAsset.deleteMany({ where: { ownerId: USER_ID } });
  await prisma.user.deleteMany({ where: { id: USER_ID } });
}

beforeEach(async () => {
  await cleanFixture();
  await prisma.user.create({
    data: {
      id: USER_ID,
      email: "phase14a@example.com",
      username: "phase14a-user",
      displayName: "Phase 14a User",
      passwordHash: "not-used",
    },
  });
});

afterEach(cleanFixture);

async function createPending(id: string, publicUrl: string) {
  return repository.createPendingAvatar({
    id,
    ownerId: USER_ID,
    declaredContentType: "image/png",
    declaredSize: 4,
    incomingObjectKey: `incoming/${id}`,
    readyObjectKey: `public/${id}.webp`,
    publicUrl,
    uploadExpiresAt: new Date(NOW.getTime() + 600_000),
  });
}

async function complete(id: string) {
  expect(await repository.claimForProcessing(USER_ID, id, NOW)).toBe(true);
  return repository.completeAvatar({
    assetId: id,
    ownerId: USER_ID,
    detectedContentType: "image/png",
    actualSize: 4,
    width: 512,
    height: 512,
    readyAt: NOW,
  });
}

describe("phase 14a PostgreSQL behavior", () => {
  it("atomically marks an avatar ready and attaches it to the user", async () => {
    const publicUrl = `http://storage/avatars/public/${FIRST_ID}.webp`;
    await createPending(FIRST_ID, publicUrl);

    const user = await complete(FIRST_ID);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: FIRST_ID },
    });

    expect(user?.avatarUrl).toBe(publicUrl);
    expect(asset.status).toBe("READY");
    expect(asset.readyAt).toEqual(NOW);
    expect(
      await repository.findOwnedAvatar(USER_ID, FIRST_ID),
    ).toEqual(expect.objectContaining({ isCurrent: true }));
  });

  it("leaves replaced and removed avatar objects for asynchronous cleanup", async () => {
    await createPending(
      FIRST_ID,
      `http://storage/avatars/public/${FIRST_ID}.webp`,
    );
    await complete(FIRST_ID);
    await createPending(
      SECOND_ID,
      `http://storage/avatars/public/${SECOND_ID}.webp`,
    );
    await complete(SECOND_ID);

    const afterReplace = await repository.listCleanupCandidates(
      NOW,
      new Date(NOW.getTime() - 3_600_000),
      100,
    );
    expect(afterReplace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: FIRST_ID, isCurrent: false }),
        expect.objectContaining({ id: SECOND_ID, isCurrent: true }),
      ]),
    );

    const user = await repository.removeCurrentAvatar(USER_ID);
    const afterDelete = await repository.listCleanupCandidates(
      NOW,
      new Date(NOW.getTime() - 3_600_000),
      100,
    );

    expect(user?.avatarUrl).toBeNull();
    expect(afterDelete.filter((asset) => asset.status === "READY")).toHaveLength(2);
    expect(afterDelete.every((asset) => !asset.isCurrent)).toBe(true);
  });
});
