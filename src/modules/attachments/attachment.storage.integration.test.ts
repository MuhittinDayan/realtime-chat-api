import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/database/prisma.js";
import {
  objectStorage,
  storageBuckets,
  storageSettings,
  StorageObjectNotFoundError,
} from "../../infrastructure/storage/index.js";
import {
  AttachmentBindingError,
  AttachmentNotFoundError,
} from "./attachment.errors.js";
import { PrismaConversationRepository } from "../conversations/conversation.repository.js";
import { ConversationService } from "../conversations/conversation.service.js";
import { PrismaMessageRepository } from "../messages/message.repository.js";
import { MessageService } from "../messages/message.service.js";
import { SharpAttachmentImageProcessor } from "./attachment-image.processor.js";
import { PrismaAttachmentRepository } from "./attachment.repository.js";
import { AttachmentService } from "./attachment.service.js";
import { AvatarCleanupService } from "../media/avatar-cleanup.service.js";
import { PrismaAvatarRepository } from "../media/avatar.repository.js";

const ALICE_ID = "71000000-0000-4000-8000-000000000001";
const BOB_ID = "71000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "72000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "73000000-0000-4000-8000-000000000001";
const ASSET_ID = "74000000-0000-4000-8000-000000000001";
const MESSAGE_IDEMPOTENCY_KEY = "75000000-0000-4000-8000-000000000001";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const incomingKey = `incoming/${ALICE_ID}/${ASSET_ID}`;
const originalKey = `ready/${ALICE_ID}/${ASSET_ID}/original.webp`;
const thumbnailKey = `ready/${ALICE_ID}/${ASSET_ID}/thumbnail.webp`;

async function cleanFixture(): Promise<void> {
  await prisma.messageRead.deleteMany({
    where: { conversationId: CONVERSATION_ID },
  });
  await prisma.message.deleteMany({
    where: { conversationId: CONVERSATION_ID },
  });
  await prisma.mediaAsset.deleteMany({
    where: { id: ASSET_ID },
  });
  await prisma.conversationMember.deleteMany({
    where: { conversationId: CONVERSATION_ID },
  });
  await prisma.conversation.deleteMany({
    where: { id: CONVERSATION_ID },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [ALICE_ID, BOB_ID] } },
  });
  await Promise.all(
    [incomingKey, originalKey, thumbnailKey].map((key) =>
      objectStorage.deleteObject({
        bucket: storageBuckets.attachment,
        key,
      }),
    ),
  );
}

async function seedConversation(): Promise<void> {
  await prisma.user.createMany({
    data: [
      {
        id: ALICE_ID,
        email: "alice.attachment@example.com",
        username: "alice_attachment",
        displayName: "Alice Attachment",
        passwordHash: "not-used",
      },
      {
        id: BOB_ID,
        email: "bob.attachment@example.com",
        username: "bob_attachment",
        displayName: "Bob Attachment",
        passwordHash: "not-used",
      },
    ],
  });
  await prisma.conversation.create({
    data: {
      id: CONVERSATION_ID,
      type: "DIRECT",
      directKey: `${ALICE_ID}:${BOB_ID}`,
      createdById: ALICE_ID,
      members: {
        create: [
          { userId: ALICE_ID, role: "MEMBER" },
          { userId: BOB_ID, role: "MEMBER" },
        ],
      },
    },
  });
}

beforeEach(async () => {
  await cleanFixture();
  await seedConversation();
});

afterEach(cleanFixture);

function createServices() {
  const conversationService = new ConversationService(
    new PrismaConversationRepository(prisma),
  );
  const ids = [ATTACHMENT_ID, ASSET_ID];
  const attachmentService = new AttachmentService(
    new PrismaAttachmentRepository(prisma),
    objectStorage,
    new SharpAttachmentImageProcessor(),
    conversationService,
    {
      attachmentBucket: storageBuckets.attachment,
      uploadUrlTtlSeconds: storageSettings.avatarUploadUrlTtlSeconds,
      downloadUrlTtlSeconds:
        storageSettings.attachmentDownloadUrlTtlSeconds,
    },
    () => NOW,
    () => ids.shift() ?? ASSET_ID,
  );
  const messageService = new MessageService(
    new PrismaMessageRepository(prisma),
    conversationService,
    {
      publishMessageCreated: () => undefined,
      publishMessageUpdated: () => undefined,
      publishMessageDeleted: () => undefined,
    },
  );

  return { attachmentService, messageService };
}

describe("phase 14b real PostgreSQL and MinIO behavior", () => {
  it("uploads, processes, binds and reads a private image attachment", async () => {
    const source = await sharp({
      create: {
        width: 1_600,
        height: 900,
        channels: 3,
        background: "green",
      },
    })
      .png()
      .toBuffer();
    const { attachmentService, messageService } = createServices();
    const intent = await attachmentService.createUpload(
      ALICE_ID,
      CONVERSATION_ID,
      {
        contentType: "image/png",
        contentLength: source.byteLength,
        originalFileName: "holiday.png",
      },
    );
    const uploadResponse = await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: source,
    });

    expect(uploadResponse.ok).toBe(true);
    const completed = await attachmentService.completeUpload(
      ALICE_ID,
      CONVERSATION_ID,
      intent.attachmentId,
    );
    const created = await messageService.createMessage(
      ALICE_ID,
      CONVERSATION_ID,
      {
        clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
        content: {
          type: "media",
          text: "Holiday",
          attachmentIds: [intent.attachmentId],
        },
      },
    );
    const retry = await messageService.createMessage(
      ALICE_ID,
      CONVERSATION_ID,
      {
        clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
        content: {
          type: "media",
          text: "Holiday",
          attachmentIds: [intent.attachmentId],
        },
      },
    );
    const captionRemoved = await messageService.updateMessage(
      ALICE_ID,
      CONVERSATION_ID,
      created.message.id,
      { content: { type: "media", text: null } },
    );
    const thumbnailAccess = await attachmentService.createAccess(
      BOB_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
      "thumbnail",
    );
    const originalAccess = await attachmentService.createAccess(
      BOB_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
      "original",
    );
    const [thumbnailResponse, originalResponse] = await Promise.all([
      fetch(thumbnailAccess.url),
      fetch(originalAccess.url),
    ]);
    const [thumbnailMetadata, originalMetadata] = await Promise.all([
      sharp(new Uint8Array(await thumbnailResponse.arrayBuffer())).metadata(),
      sharp(new Uint8Array(await originalResponse.arrayBuffer())).metadata(),
    ]);

    expect(completed.thumbnailUrl).toContain(`/${ATTACHMENT_ID}/thumbnail`);
    expect(created).toMatchObject({
      created: true,
      message: {
        kind: "MEDIA",
        body: "Holiday",
        attachments: [{ id: ATTACHMENT_ID }],
      },
    });
    expect(retry).toEqual({ message: created.message, created: false });
    expect(captionRemoved).toMatchObject({
      kind: "MEDIA",
      body: null,
      attachments: [{ id: ATTACHMENT_ID }],
    });
    await expect(
      messageService.createMessage(ALICE_ID, CONVERSATION_ID, {
        clientMessageId: "75000000-0000-4000-8000-000000000002",
        content: {
          type: "media",
          attachmentIds: [ATTACHMENT_ID],
        },
      }),
    ).rejects.toBeInstanceOf(AttachmentBindingError);
    expect(thumbnailResponse.ok).toBe(true);
    expect(originalResponse.ok).toBe(true);
    expect(thumbnailMetadata).toEqual(
      expect.objectContaining({ format: "webp", width: 480, height: 270 }),
    );
    expect(originalMetadata).toEqual(
      expect.objectContaining({ format: "webp", width: 1_600, height: 900 }),
    );
    await expect(
      objectStorage.headObject({
        bucket: storageBuckets.attachment,
        key: incomingKey,
      }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);

    const storedAttachment = await prisma.messageAttachment.findUniqueOrThrow({
      where: { id: ATTACHMENT_ID },
      include: { asset: true },
    });
    expect(storedAttachment.messageId).toBe(created.message.id);
    expect(storedAttachment.asset).toMatchObject({
      purpose: "MESSAGE_ATTACHMENT",
      status: "READY",
      incomingObjectKey: null,
      publicUrl: null,
    });

    const deleted = await messageService.deleteMessage(
      ALICE_ID,
      CONVERSATION_ID,
      created.message.id,
    );
    expect(deleted).toMatchObject({
      kind: "MEDIA",
      body: null,
      attachments: [],
    });
    await expect(
      attachmentService.createAccess(
        BOB_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
        "original",
      ),
    ).rejects.toBeInstanceOf(AttachmentNotFoundError);
    await expect(
      objectStorage.headObject({
        bucket: storageBuckets.attachment,
        key: originalKey,
      }),
    ).resolves.toMatchObject({ contentType: "image/webp" });

    const retention = await prisma.messageAttachment.findUniqueOrThrow({
      where: { id: ATTACHMENT_ID },
      select: { purgeAfter: true },
    });
    expect(retention.purgeAfter).not.toBeNull();
    const cleanupNow = new Date(
      (retention.purgeAfter?.getTime() ?? 0) + 1,
    );
    const cleanup = new AvatarCleanupService(
      new PrismaAvatarRepository(prisma),
      objectStorage,
      {
        avatarBucket: storageBuckets.avatar,
        attachmentBucket: storageBuckets.attachment,
        staleUploadAgeMs: storageSettings.staleUploadAgeMs,
        unboundAttachmentAgeMs: storageSettings.unboundAttachmentAgeMs,
      },
      () => cleanupNow,
      new PrismaAttachmentRepository(prisma),
    );

    await expect(cleanup.runOnce()).resolves.toMatchObject({
      deletedAssets: 1,
    });
    await expect(
      objectStorage.headObject({
        bucket: storageBuckets.attachment,
        key: originalKey,
      }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    await expect(
      prisma.messageAttachment.findUnique({ where: { id: ATTACHMENT_ID } }),
    ).resolves.toBeNull();
  });

  it("rechecks membership inside the media binding transaction", async () => {
    await prisma.mediaAsset.create({
      data: {
        id: ASSET_ID,
        ownerId: ALICE_ID,
        purpose: "MESSAGE_ATTACHMENT",
        status: "READY",
        declaredContentType: "image/png",
        declaredSize: 4,
        detectedContentType: "image/png",
        actualSize: 4,
        width: 640,
        height: 480,
        readyObjectKey: originalKey,
        uploadExpiresAt: new Date(NOW.getTime() + 600_000),
        readyAt: NOW,
        messageAttachment: {
          create: {
            id: ATTACHMENT_ID,
            conversationId: CONVERSATION_ID,
            originalFileName: "photo.png",
            thumbnailObjectKey: thumbnailKey,
          },
        },
      },
    });
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: ALICE_ID,
        },
      },
      data: { leftAt: NOW },
    });

    await expect(
      new PrismaMessageRepository(prisma).createMessage({
        conversationId: CONVERSATION_ID,
        senderId: ALICE_ID,
        clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
        kind: "MEDIA",
        body: null,
        attachmentIds: [ATTACHMENT_ID],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    await expect(prisma.message.count()).resolves.toBe(0);
    await expect(
      prisma.messageAttachment.findUniqueOrThrow({
        where: { id: ATTACHMENT_ID },
        select: { messageId: true },
      }),
    ).resolves.toEqual({ messageId: null });
  });

  it("rejects complete after membership removal and later cleans the upload", async () => {
    const source = await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: "blue",
      },
    })
      .png()
      .toBuffer();
    const { attachmentService } = createServices();
    const intent = await attachmentService.createUpload(
      ALICE_ID,
      CONVERSATION_ID,
      {
        contentType: "image/png",
        contentLength: source.byteLength,
        originalFileName: "removed-member.png",
      },
    );
    const uploaded = await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: source,
    });
    expect(uploaded.ok).toBe(true);
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: ALICE_ID,
        },
      },
      data: { leftAt: NOW },
    });

    await expect(
      attachmentService.completeUpload(
        ALICE_ID,
        CONVERSATION_ID,
        intent.attachmentId,
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "CONVERSATION_NOT_FOUND",
    });
    await expect(
      objectStorage.headObject({
        bucket: storageBuckets.attachment,
        key: incomingKey,
      }),
    ).resolves.toBeDefined();

    const cleanup = new AvatarCleanupService(
      new PrismaAvatarRepository(prisma),
      objectStorage,
      {
        avatarBucket: storageBuckets.avatar,
        attachmentBucket: storageBuckets.attachment,
        staleUploadAgeMs: storageSettings.staleUploadAgeMs,
        unboundAttachmentAgeMs: storageSettings.unboundAttachmentAgeMs,
      },
      () =>
        new Date(
          NOW.getTime() +
            storageSettings.avatarUploadUrlTtlSeconds * 1_000 +
            storageSettings.staleUploadAgeMs +
            1,
        ),
      new PrismaAttachmentRepository(prisma),
    );

    await expect(cleanup.runOnce()).resolves.toMatchObject({
      deletedAssets: 1,
    });
    await expect(
      objectStorage.headObject({
        bucket: storageBuckets.attachment,
        key: incomingKey,
      }),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("enforces the attachment count again inside the media transaction", async () => {
    await expect(
      new PrismaMessageRepository(prisma).createMessage({
        conversationId: CONVERSATION_ID,
        senderId: ALICE_ID,
        clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
        kind: "MEDIA",
        body: null,
        attachmentIds: [],
      }),
    ).rejects.toBeInstanceOf(AttachmentBindingError);
    await expect(prisma.message.count()).resolves.toBe(0);
  });
});
