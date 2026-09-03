import { describe, expect, it } from "vitest";

import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import type {
  CreatedNotificationRecord,
  CreateMessageRepositoryInput,
  CreateMessageRepositoryResult,
  ListMessagesRepositoryInput,
  MessageMutationRepositoryResult,
  MessageRecord,
  MessageRepository,
  SoftDeleteMessageRepositoryInput,
  UpdateMessageRepositoryInput,
} from "./message.repository.js";
import type { NotificationPublisher } from "../notifications/notification.events.js";
import { MessageNotFoundError } from "./message.errors.js";
import {
  createMessageBodySchema,
  messageHistoryQuerySchema,
  updateMessageBodySchema,
} from "./message.schema.js";
import {
  MessageService,
  type ConversationAccessService,
  type MessageDto,
  type MessagePublisher,
} from "./message.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "55555555-5555-4555-8555-555555555555";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function createMediaMessage(input: { attachmentIds: string[] }) {
  return createMessageBodySchema.safeParse({
    clientMessageId: CLIENT_MESSAGE_ID,
    content: { type: "media", attachmentIds: input.attachmentIds },
  });
}

function createRecord(
  index: number,
  createdAt = new Date(NOW.getTime() + index * 1_000),
): MessageRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    conversationId: CONVERSATION_ID,
    senderId: ALICE_ID,
    clientMessageId:
      index === 1
        ? CLIENT_MESSAGE_ID
        : `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "TEXT",
    body: `message ${index}`,
    createdAt,
    editedAt: null,
    deletedAt: null,
    attachments: [],
  };
}

class InMemoryMessageRepository implements MessageRepository {
  readonly records: MessageRecord[] = [];
  createCount = 0;
  readonly lifecycle: string[];
  notificationsOnCreate: readonly CreatedNotificationRecord[] = [];
  lastAttachmentPurgeAfter: Date | null = null;

  constructor(lifecycle: string[] = []) {
    this.lifecycle = lifecycle;
  }

  async createMessage(
    input: CreateMessageRepositoryInput,
  ): Promise<CreateMessageRepositoryResult> {
    const existing = this.records.find(
      (message) =>
        message.senderId === input.senderId &&
        message.clientMessageId === input.clientMessageId,
    );

    if (existing !== undefined) {
      return { message: existing, created: false, notifications: [] };
    }

    this.createCount += 1;
    const message: MessageRecord = {
      ...createRecord(this.createCount),
      conversationId: input.conversationId,
      senderId: input.senderId,
      clientMessageId: input.clientMessageId,
      kind: input.kind,
      body: input.body,
    };
    this.records.push(message);
    this.lifecycle.push("commit");
    return {
      message,
      created: true,
      notifications: this.notificationsOnCreate,
    };
  }

  async listMessages(
    input: ListMessagesRepositoryInput,
  ): Promise<readonly MessageRecord[]> {
    return this.records
      .filter((message) => {
        if (message.conversationId !== input.conversationId) {
          return false;
        }

        if (input.before === undefined) {
          return true;
        }

        return (
          message.createdAt < input.before.createdAt ||
          (message.createdAt.getTime() ===
            input.before.createdAt.getTime() &&
            message.id < input.before.id)
        );
      })
      .sort(
        (first, second) =>
          second.createdAt.getTime() - first.createdAt.getTime() ||
          second.id.localeCompare(first.id),
      )
      .slice(0, input.take);
  }

  async updateMessage(
    input: UpdateMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    const message = this.records.find(
      (record) =>
        record.id === input.messageId &&
        record.conversationId === input.conversationId &&
        record.senderId === input.senderId &&
        record.kind === input.kind &&
        record.deletedAt === null,
    );

    if (message === undefined) {
      return { message: null, changed: false };
    }

    if (message.body === input.body) {
      return { message, changed: false };
    }

    message.body = input.body;
    message.editedAt = input.editedAt;
    this.lifecycle.push("commit");
    return { message, changed: true };
  }

  async softDeleteMessage(
    input: SoftDeleteMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    const message = this.records.find(
      (record) =>
        record.id === input.messageId &&
        record.conversationId === input.conversationId &&
        record.senderId === input.senderId,
    );

    if (message === undefined) {
      return { message: null, changed: false };
    }

    if (message.deletedAt !== null) {
      return { message, changed: false };
    }

    message.deletedAt = input.deletedAt;
    this.lastAttachmentPurgeAfter = input.attachmentPurgeAfter;
    this.lifecycle.push("commit");
    return { message, changed: true };
  }
}

class FakeConversationAccess implements ConversationAccessService {
  constructor(readonly allowed: boolean) {}

  async isActiveMember(): Promise<boolean> {
    return this.allowed;
  }
}

class RecordingPublisher implements MessagePublisher {
  readonly messages: MessageDto[] = [];
  readonly updatedMessages: MessageDto[] = [];
  readonly deletedMessages: MessageDto[] = [];

  constructor(private readonly lifecycle: string[] = []) {}

  publishMessageCreated(message: MessageDto): void {
    this.lifecycle.push("publish");
    this.messages.push(message);
  }

  publishMessageUpdated(message: MessageDto): void {
    this.lifecycle.push("publish:update");
    this.updatedMessages.push(message);
  }

  publishMessageDeleted(message: MessageDto): void {
    this.lifecycle.push("publish:delete");
    this.deletedMessages.push(message);
  }
}

describe("message service creation", () => {
  it("publishes created notifications after commit and tolerates emit failure", async () => {
    const lifecycle: string[] = [];
    const repository = new InMemoryMessageRepository(lifecycle);
    repository.notificationsOnCreate = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        type: "MESSAGE_CREATED",
        recipientUserId: BOB_ID,
        conversationId: CONVERSATION_ID,
        messageId: createRecord(1).id,
        createdAt: NOW,
      },
    ];
    const notificationPublisher: NotificationPublisher = {
      publishCreated: () => {
        lifecycle.push("publish:notification");
        throw new Error("socket unavailable");
      },
      publishRead: () => undefined,
      publishConversationRead: () => undefined,
    };
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      new RecordingPublisher(lifecycle),
      undefined,
      undefined,
      notificationPublisher,
    );

    await expect(
      service.createMessage(ALICE_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "hello" },
      }),
    ).resolves.toMatchObject({ created: true });
    expect(lifecycle).toEqual([
      "commit",
      "publish",
      "publish:notification",
    ]);
  });

  it("validates one to four unique attachment ids for MEDIA messages", () => {
    const attachmentId = "99999999-9999-4999-8999-999999999999";
    expect(
      createMediaMessage({ attachmentIds: [attachmentId] }).success,
    ).toBe(true);
    expect(
      createMediaMessage({ attachmentIds: [attachmentId, attachmentId] }).success,
    ).toBe(false);
    expect(
      createMediaMessage({
        attachmentIds: [1, 2, 3, 4, 5].map(
          (index) =>
            `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("creates, trims and publishes a message only after repository commit", async () => {
    const lifecycle: string[] = [];
    const repository = new InMemoryMessageRepository(lifecycle);
    const publisher = new RecordingPublisher(lifecycle);
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
    );

    const result = await service.createMessage(ALICE_ID, CONVERSATION_ID, {
      clientMessageId: CLIENT_MESSAGE_ID,
      content: { type: "text", text: "hello" },
    });

    expect(result.created).toBe(true);
    expect(result.message.body).toBe("hello");
    expect(publisher.messages).toEqual([result.message]);
    expect(lifecycle).toEqual(["commit", "publish"]);
  });

  it("returns the same message for a retry without writing or emitting", async () => {
    const repository = new InMemoryMessageRepository();
    const publisher = new RecordingPublisher();
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
    );
    const input = {
      clientMessageId: CLIENT_MESSAGE_ID,
      content: { type: "text" as const, text: "hello" },
    };

    const first = await service.createMessage(
      ALICE_ID,
      CONVERSATION_ID,
      input,
    );
    const retry = await service.createMessage(
      ALICE_ID,
      CONVERSATION_ID,
      input,
    );

    expect(retry.message.id).toBe(first.message.id);
    expect(retry.created).toBe(false);
    expect(repository.createCount).toBe(1);
    expect(publisher.messages).toHaveLength(1);
  });

  it("hides the conversation from a non-member", async () => {
    const service = new MessageService(
      new InMemoryMessageRepository(),
      new FakeConversationAccess(false),
      new RecordingPublisher(),
    );

    await expect(
      service.createMessage(ALICE_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "hello" },
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("message history service", () => {
  it("returns the latest page chronologically and cursors before its oldest row", async () => {
    const repository = new InMemoryMessageRepository();
    repository.records.push(createRecord(1), createRecord(2), createRecord(3));
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      new RecordingPublisher(),
    );

    const firstPage = await service.listMessages(ALICE_ID, CONVERSATION_ID, {
      limit: 2,
    });
    const decoded = messageHistoryQuerySchema.parse({
      before: firstPage.nextCursor,
    });
    const secondPage = await service.listMessages(
      ALICE_ID,
      CONVERSATION_ID,
      { limit: 2, before: decoded.before },
    );

    expect(firstPage.items.map((message) => message.body)).toEqual([
      "message 2",
      "message 3",
    ]);
    expect(secondPage.items.map((message) => message.body)).toEqual([
      "message 1",
    ]);
  });

  it("keeps a deleted message in cursor order while masking its body", async () => {
    const repository = new InMemoryMessageRepository();
    const deleted = createRecord(2);
    deleted.deletedAt = NOW;
    repository.records.push(createRecord(1), deleted, createRecord(3));
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      new RecordingPublisher(),
    );

    const page = await service.listMessages(ALICE_ID, CONVERSATION_ID, {
      limit: 3,
    });

    expect(page.items.map((message) => message.id)).toEqual([
      createRecord(1).id,
      deleted.id,
      createRecord(3).id,
    ]);
    expect(page.items[1]).toMatchObject({
      id: deleted.id,
      body: null,
      deletedAt: NOW,
    });
  });

  it("prevents a non-member from reading history", async () => {
    const service = new MessageService(
      new InMemoryMessageRepository(),
      new FakeConversationAccess(false),
      new RecordingPublisher(),
    );

    await expect(
      service.listMessages(ALICE_ID, CONVERSATION_ID, { limit: 50 }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

describe("message lifecycle service", () => {
  it("strictly validates MEDIA caption-only updates", () => {
    expect(
      updateMessageBodySchema.safeParse({
        content: { type: "media", text: null },
      }).success,
    ).toBe(true);
    expect(
      updateMessageBodySchema.safeParse({
        content: {
          type: "media",
          text: "caption",
          attachmentIds: ["99999999-9999-4999-8999-999999999999"],
        },
      }).success,
    ).toBe(false);
  });

  it("updates only a MEDIA caption and can remove it with null", async () => {
    const repository = new InMemoryMessageRepository();
    const original: MessageRecord = {
      ...createRecord(1),
      kind: "MEDIA",
      body: "caption",
      attachments: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          conversationId: CONVERSATION_ID,
          kind: "IMAGE",
          originalFileName: "photo.png",
          position: 0,
          actualSize: 4,
          detectedContentType: "image/png",
          width: 640,
          height: 480,
          readyObjectKey: "ready/original.webp",
          thumbnailObjectKey: "ready/thumbnail.webp",
        },
      ],
    };
    repository.records.push(original);
    const publisher = new RecordingPublisher();
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    const updated = await service.updateMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
      { content: { type: "media", text: null } },
    );

    expect(updated).toMatchObject({
      kind: "MEDIA",
      body: null,
      editedAt: NOW,
      attachments: [{ id: original.attachments[0]?.id }],
    });
    expect(original.attachments).toHaveLength(1);
    expect(publisher.updatedMessages).toEqual([updated]);
  });

  it("lets the sender update content and publishes only after commit", async () => {
    const lifecycle: string[] = [];
    const repository = new InMemoryMessageRepository(lifecycle);
    const original = createRecord(1);
    repository.records.push(original);
    const publisher = new RecordingPublisher(lifecycle);
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    const updated = await service.updateMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
      { content: { type: "text", text: "updated" } },
    );

    expect(updated).toMatchObject({ body: "updated", editedAt: NOW });
    expect(publisher.updatedMessages).toEqual([updated]);
    expect(lifecycle).toEqual(["commit", "publish:update"]);
  });

  it("treats an update with identical normalized content as a no-op", async () => {
    const repository = new InMemoryMessageRepository();
    const original = createRecord(1);
    repository.records.push(original);
    const publisher = new RecordingPublisher();
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    const unchanged = await service.updateMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
      { content: { type: "text", text: original.body ?? "" } },
    );

    expect(unchanged.editedAt).toBeNull();
    expect(publisher.updatedMessages).toHaveLength(0);
  });

  it("hides a message from a participant who is not its sender", async () => {
    const repository = new InMemoryMessageRepository();
    const original = createRecord(1);
    repository.records.push(original);
    const publisher = new RecordingPublisher();
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    await expect(
      service.updateMessage(BOB_ID, CONVERSATION_ID, original.id, {
        content: { type: "text", text: "not allowed" },
      }),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
    await expect(
      service.deleteMessage(BOB_ID, CONVERSATION_ID, original.id),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(publisher.updatedMessages).toHaveLength(0);
    expect(publisher.deletedMessages).toHaveLength(0);
  });

  it("soft-deletes once, masks content and keeps repeated deletion idempotent", async () => {
    const lifecycle: string[] = [];
    const repository = new InMemoryMessageRepository(lifecycle);
    const original = createRecord(1);
    repository.records.push(original);
    const publisher = new RecordingPublisher(lifecycle);
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    const deleted = await service.deleteMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
    );
    const retry = await service.deleteMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
    );

    expect(deleted).toMatchObject({ body: null, deletedAt: NOW });
    expect(retry).toEqual(deleted);
    expect(original.body).toBe("message 1");
    expect(publisher.deletedMessages).toEqual([deleted]);
    expect(repository.lastAttachmentPurgeAfter).toEqual(
      new Date(NOW.getTime() + 2_592_000_000),
    );
    expect(lifecycle).toEqual(["commit", "publish:delete"]);
    await expect(
      service.updateMessage(ALICE_ID, CONVERSATION_ID, original.id, {
        content: { type: "text", text: "cannot revive" },
      }),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
  });

  it("hides MEDIA attachments from the deletion response and event", async () => {
    const repository = new InMemoryMessageRepository();
    const original: MessageRecord = {
      ...createRecord(1),
      kind: "MEDIA",
      body: "caption",
      attachments: [
        {
          id: "99999999-9999-4999-8999-999999999999",
          conversationId: CONVERSATION_ID,
          kind: "IMAGE",
          originalFileName: "photo.png",
          position: 0,
          actualSize: 4,
          detectedContentType: "image/png",
          width: 640,
          height: 480,
          readyObjectKey: "ready/original.webp",
          thumbnailObjectKey: "ready/thumbnail.webp",
        },
      ],
    };
    repository.records.push(original);
    const publisher = new RecordingPublisher();
    const service = new MessageService(
      repository,
      new FakeConversationAccess(true),
      publisher,
      { now: () => NOW },
    );

    const deleted = await service.deleteMessage(
      ALICE_ID,
      CONVERSATION_ID,
      original.id,
    );

    expect(deleted).toMatchObject({
      kind: "MEDIA",
      body: null,
      attachments: [],
    });
    expect(publisher.deletedMessages).toEqual([deleted]);
  });

  it("hides the conversation before looking up a message for a non-member", async () => {
    const service = new MessageService(
      new InMemoryMessageRepository(),
      new FakeConversationAccess(false),
      new RecordingPublisher(),
      { now: () => NOW },
    );

    await expect(
      service.deleteMessage(ALICE_ID, CONVERSATION_ID, createRecord(1).id),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
