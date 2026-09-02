import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env } from "../../../config/env.ts";
import { prisma } from "../../../infrastructure/database/prisma.ts";
import {
  objectStorage,
  storageBuckets,
  storageSettings,
  StorageObjectNotFoundError,
} from "../../../infrastructure/storage/index.ts";
import {
  AttachmentBindingError,
  AttachmentNotFoundError,
} from "../domain/attachment.errors.ts";
import { PrismaConversationRepository } from "../../conversations/conversation.repository.ts";
import { ConversationService } from "../../conversations/conversation.service.ts";
import { PrismaMessageRepository } from "../../messages/message.repository.ts";
import { MessageService } from "../../messages/message.service.ts";
import { SharpAttachmentImageProcessor } from "../processing/attachment-image.processor.ts";
import { PrismaAttachmentRepository } from "./attachment.repository.ts";
import { AttachmentService } from "../application/attachment.service.ts";
import { PdfJsAttachmentPdfProcessor } from "../processing/attachment-pdf.processor.ts";
import { ClamAvAttachmentScanner } from "../processing/clamav-scanner.ts";
import { AvatarCleanupService } from "../../media/avatar-cleanup.service.ts";
import { PrismaAvatarRepository } from "../../media/avatar.repository.ts";

const ALICE_ID = "71000000-0000-4000-8000-000000000001";
const BOB_ID = "71000000-0000-4000-8000-000000000002";
const CONVERSATION_ID = "72000000-0000-4000-8000-000000000001";
const ATTACHMENT_ID = "73000000-0000-4000-8000-000000000001";
const ASSET_ID = "74000000-0000-4000-8000-000000000001";
const MESSAGE_IDEMPOTENCY_KEY = "75000000-0000-4000-8000-000000000001";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const incomingKey = `incoming/${ALICE_ID}/${ASSET_ID}`;
const originalKey = `ready/${ALICE_ID}/${ASSET_ID}/original.webp`;
const pdfOriginalKey = `ready/${ALICE_ID}/${ASSET_ID}/original.pdf`;
const thumbnailKey = `ready/${ALICE_ID}/${ASSET_ID}/thumbnail.webp`;
const itWithUnavailableClamAv =
  process.env.EXPECT_CLAMAV_UNAVAILABLE === "true" ? it : it.skip;

async function cleanFixture(): Promise<void> {
  await prisma.messageRead.deleteMany({
    where: { conversationId: CONVERSATION_ID },
  });
  await prisma.message.deleteMany({
    where: { conversationId: CONVERSATION_ID },
  });
  await prisma.mediaAsset.deleteMany({
    where: {
      ownerId: { in: [ALICE_ID, BOB_ID] },
      purpose: "MESSAGE_ATTACHMENT",
    },
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
    [incomingKey, originalKey, pdfOriginalKey, thumbnailKey].map((key) =>
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
    new PdfJsAttachmentPdfProcessor(),
    new ClamAvAttachmentScanner({
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_SCAN_TIMEOUT_MS,
      maxConcurrentScans: env.CLAMAV_MAX_CONCURRENT_SCANS,
      streamMaxLengthBytes: env.CLAMAV_STREAM_MAX_LENGTH_BYTES,
    }),
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

describe("phase 14b/14c real PostgreSQL, MinIO, and ClamAV behavior", () => {
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

    expect(completed.kind).toBe("IMAGE");
    expect(completed.kind === "IMAGE" ? completed.thumbnailUrl : null).toContain(
      `/${ATTACHMENT_ID}/thumbnail`,
    );
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

  it("uploads, scans, binds and downloads a private PDF attachment", async () => {
    const source = buildMinimalPdf();
    const { attachmentService, messageService } = createServices();
    const intent = await attachmentService.createUpload(
      ALICE_ID,
      CONVERSATION_ID,
      {
        contentType: "application/pdf",
        contentLength: source.byteLength,
        originalFileName: "güvenli rapor.pdf",
      },
    );
    const uploaded = await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: source,
    });
    expect(uploaded.ok).toBe(true);

    const completed = await attachmentService.completeUpload(
      ALICE_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
    );
    expect(completed).toMatchObject({
      kind: "PDF",
      contentType: "application/pdf",
    });
    await messageService.createMessage(ALICE_ID, CONVERSATION_ID, {
      clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
      content: { type: "media", attachmentIds: [ATTACHMENT_ID] },
    });

    const access = await attachmentService.createAccess(
      BOB_ID,
      CONVERSATION_ID,
      ATTACHMENT_ID,
      "original",
    );
    const downloaded = await fetch(access.url);

    expect(downloaded.ok).toBe(true);
    expect(downloaded.headers.get("content-type")).toContain("application/pdf");
    expect(downloaded.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(source);
    await expect(
      prisma.messageAttachment.findUniqueOrThrow({
        where: { id: ATTACHMENT_ID },
        select: {
          kind: true,
          thumbnailObjectKey: true,
          asset: { select: { status: true, width: true, height: true } },
        },
      }),
    ).resolves.toEqual({
      kind: "PDF",
      thumbnailObjectKey: null,
      asset: { status: "READY", width: null, height: null },
    });
  });

  it("marks an EICAR-bearing PDF as REJECTED", async () => {
    const source = buildMinimalPdf(
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    );
    const { attachmentService } = createServices();
    const intent = await attachmentService.createUpload(
      ALICE_ID,
      CONVERSATION_ID,
      {
        contentType: "application/pdf",
        contentLength: source.byteLength,
        originalFileName: "eicar.pdf",
      },
    );
    await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: source,
    });

    await expect(
      attachmentService.completeUpload(
        ALICE_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_FILE" });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: ASSET_ID },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "REJECTED" });
  });

  itWithUnavailableClamAv(
    "returns 503 without rejecting the asset when clamd is stopped",
    async () => {
      const source = buildMinimalPdf();
      const { attachmentService } = createServices();
      const intent = await attachmentService.createUpload(
        ALICE_ID,
        CONVERSATION_ID,
        {
          contentType: "application/pdf",
          contentLength: source.byteLength,
          originalFileName: "retry.pdf",
        },
      );
      await fetch(intent.upload.url, {
        method: intent.upload.method,
        headers: intent.upload.headers,
        body: source,
      });

      await expect(
        attachmentService.completeUpload(
          ALICE_ID,
          CONVERSATION_ID,
          ATTACHMENT_ID,
        ),
      ).rejects.toMatchObject({
        statusCode: 503,
        code: "ATTACHMENT_SCAN_UNAVAILABLE",
      });
      await expect(
        prisma.mediaAsset.findUniqueOrThrow({
          where: { id: ASSET_ID },
          select: { status: true },
        }),
      ).resolves.toEqual({ status: "PENDING" });
    },
  );

  it.each([
    ["encrypted", buildMinimalPdf("", true)],
    ["corrupt", new TextEncoder().encode("%PDF-1.7\nnot a PDF\n%%EOF\n")],
  ])("marks a %s PDF as REJECTED", async (_label, source) => {
    const { attachmentService } = createServices();
    const intent = await attachmentService.createUpload(
      ALICE_ID,
      CONVERSATION_ID,
      {
        contentType: "application/pdf",
        contentLength: source.byteLength,
        originalFileName: "invalid.pdf",
      },
    );
    await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: source,
    });

    await expect(
      attachmentService.completeUpload(
        ALICE_ID,
        CONVERSATION_ID,
        ATTACHMENT_ID,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ATTACHMENT_FILE" });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: ASSET_ID },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "REJECTED" });
  });

  it("rejects a real binding transaction above 50 MiB actual size", async () => {
    const attachmentIds = [
      "76000000-0000-4000-8000-000000000001",
      "76000000-0000-4000-8000-000000000002",
      "76000000-0000-4000-8000-000000000003",
    ];

    for (const [index, attachmentId] of attachmentIds.entries()) {
      await prisma.mediaAsset.create({
        data: {
          id: `77000000-0000-4000-8000-00000000000${String(index + 1)}`,
          ownerId: ALICE_ID,
          purpose: "MESSAGE_ATTACHMENT",
          status: "READY",
          declaredContentType: "application/pdf",
          declaredSize: 20 * 1_024 * 1_024,
          detectedContentType: "application/pdf",
          actualSize: 20 * 1_024 * 1_024,
          readyObjectKey: `ready/${ALICE_ID}/seed-${String(index)}/original.pdf`,
          uploadExpiresAt: NOW,
          readyAt: NOW,
          messageAttachment: {
            create: {
              id: attachmentId,
              conversationId: CONVERSATION_ID,
              kind: "PDF",
              originalFileName: `seed-${String(index)}.pdf`,
            },
          },
        },
      });
    }

    await expect(
      new PrismaMessageRepository(prisma).createMessage({
        conversationId: CONVERSATION_ID,
        senderId: ALICE_ID,
        clientMessageId: MESSAGE_IDEMPOTENCY_KEY,
        kind: "MEDIA",
        body: null,
        attachmentIds,
      }),
    ).rejects.toMatchObject({
      code: "MESSAGE_ATTACHMENTS_TOTAL_SIZE_EXCEEDED",
    });
    await expect(prisma.message.count()).resolves.toBe(0);
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
            kind: "IMAGE",
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

  it("recovers and purges a stale PROCESSING attachment", async () => {
    const staleBefore = new Date(
      NOW.getTime() - storageSettings.staleUploadAgeMs - 1,
    );
    await objectStorage.putObject({
      bucket: storageBuckets.attachment,
      key: incomingKey,
      body: buildMinimalPdf(),
      contentType: "application/pdf",
    });
    await prisma.mediaAsset.create({
      data: {
        id: ASSET_ID,
        ownerId: ALICE_ID,
        purpose: "MESSAGE_ATTACHMENT",
        status: "PROCESSING",
        declaredContentType: "application/pdf",
        declaredSize: 4,
        incomingObjectKey: incomingKey,
        readyObjectKey: pdfOriginalKey,
        uploadExpiresAt: staleBefore,
        updatedAt: staleBefore,
        messageAttachment: {
          create: {
            id: ATTACHMENT_ID,
            conversationId: CONVERSATION_ID,
            kind: "PDF",
            originalFileName: "stale.pdf",
          },
        },
      },
    });
    const cleanup = new AvatarCleanupService(
      new PrismaAvatarRepository(prisma),
      objectStorage,
      {
        avatarBucket: storageBuckets.avatar,
        attachmentBucket: storageBuckets.attachment,
        staleUploadAgeMs: storageSettings.staleUploadAgeMs,
        unboundAttachmentAgeMs: storageSettings.unboundAttachmentAgeMs,
      },
      () => NOW,
      new PrismaAttachmentRepository(prisma),
    );

    await expect(cleanup.runOnce()).resolves.toMatchObject({ deletedAssets: 1 });
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: ASSET_ID } }),
    ).resolves.toBeNull();
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

function buildMinimalPdf(content = "", encrypted = false): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${String(Buffer.byteLength(content))} >>\nstream\n${content}\nendstream`,
    ...(encrypted
      ? [
        "<< /Filter /Standard /V 1 /R 2 " +
        "/O <0000000000000000000000000000000000000000000000000000000000000000> " +
        "/U <0000000000000000000000000000000000000000000000000000000000000000> " +
        "/P -4 >>",
      ]
      : []),
  ];
  const offsets = [0];
  let source = "%PDF-1.4\n";

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;

  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const encryptionTrailer = encrypted
    ? " /Encrypt 5 0 R " +
    "/ID [<00112233445566778899AABBCCDDEEFF>" +
    "<00112233445566778899AABBCCDDEEFF>]"
    : "";
  source +=
    `trailer\n<< /Size ${String(objects.length + 1)} ` +
    `/Root 1 0 R${encryptionTrailer} >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n`;

  return new TextEncoder().encode(source);
}
