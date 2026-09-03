import { describe, expect, it, vi } from "vitest";

import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import type { ConversationAccessService } from "../messages/message.service.js";
import type { NotificationPublisher } from "./notification.events.js";
import { NotificationNotFoundError } from "./notification.errors.js";
import type {
  NotificationRecord,
  NotificationRepository,
} from "./notification.repository.js";
import { listNotificationsQuerySchema } from "./notification.schema.js";
import { NotificationService } from "./notification.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2030-01-01T00:00:00.000Z");

function createRecord(index: number): NotificationRecord {
  return {
    id: `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type: "MESSAGE_CREATED",
    recipientUserId: USER_ID,
    conversationId: CONVERSATION_ID,
    createdAt: new Date(NOW.getTime() + index * 1_000),
    readAt: null,
    message: {
      id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      kind: "TEXT",
      body: `message ${index}`,
      createdAt: new Date(NOW.getTime() + index * 1_000),
      editedAt: null,
      deletedAt: null,
      sender: {
        id: "55555555-5555-4555-8555-555555555555",
        username: "sender",
        displayName: "Sender",
        avatarUrl: null,
      },
    },
  };
}

function createRepository(
  records: readonly NotificationRecord[] = [],
): NotificationRepository {
  return {
    listNotifications: vi.fn().mockResolvedValue(records),
    countUnread: vi.fn().mockResolvedValue(records.length),
    markRead: vi.fn().mockResolvedValue(records[0] ?? null),
    markConversationRead: vi.fn().mockResolvedValue(records.length),
  };
}

function access(allowed = true): ConversationAccessService {
  return { isActiveMember: vi.fn().mockResolvedValue(allowed) };
}

function publisher(): NotificationPublisher {
  return {
    publishCreated: vi.fn(),
    publishRead: vi.fn(),
    publishConversationRead: vi.fn(),
  };
}

describe("notification service", () => {
  it("returns a base64url keyset cursor and masks a deleted message body", async () => {
    const records = [createRecord(3), createRecord(2), createRecord(1)];
    records[1] = {
      ...records[1]!,
      message: { ...records[1]!.message, deletedAt: NOW },
    };
    const service = new NotificationService(createRepository(records), access());

    const page = await service.listNotifications(USER_ID, { limit: 2 });
    const decoded = listNotificationsQuerySchema.parse({
      cursor: page.nextCursor,
    });

    expect(page.items).toHaveLength(2);
    expect(page.items[1]?.message.body).toBeNull();
    expect(decoded.cursor).toEqual({
      createdAt: records[1]!.createdAt,
      id: records[1]!.id,
    });
  });

  it("hides a notification that is not owned by the user", async () => {
    const service = new NotificationService(createRepository(), access());
    await expect(
      service.markRead(USER_ID, createRecord(1).id),
    ).rejects.toBeInstanceOf(NotificationNotFoundError);
  });

  it("publishes a single read after persistence and tolerates publisher failure", async () => {
    const record = createRecord(1);
    const publishRead = vi
      .fn()
      .mockRejectedValue(new Error("socket unavailable"));
    const notificationPublisher: NotificationPublisher = {
      ...publisher(),
      publishRead,
    };
    const service = new NotificationService(
      createRepository([record]),
      access(),
      { now: () => NOW },
      notificationPublisher,
    );

    await expect(service.markRead(USER_ID, record.id)).resolves.toMatchObject({
      id: record.id,
    });
    expect(publishRead).toHaveBeenCalledWith({
      id: record.id,
      recipientUserId: USER_ID,
      readAt: NOW,
    });
  });

  it("requires active membership before marking a conversation", async () => {
    const repository = createRepository([createRecord(1)]);
    const service = new NotificationService(repository, access(false));

    await expect(
      service.markConversationRead(USER_ID, CONVERSATION_ID),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(repository.markConversationRead).not.toHaveBeenCalled();
  });

  it("returns the repository's marked count without touching message reads", async () => {
    const repository = createRepository([createRecord(1), createRecord(2)]);
    const notificationPublisher = publisher();
    const service = new NotificationService(
      repository,
      access(),
      { now: () => NOW },
      notificationPublisher,
    );

    await expect(
      service.markConversationRead(USER_ID, CONVERSATION_ID),
    ).resolves.toEqual({ markedCount: 2 });
    expect(repository.markConversationRead).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      readAt: NOW,
    });
    expect(
      notificationPublisher.publishConversationRead,
    ).toHaveBeenCalledWith({
      recipientUserId: USER_ID,
      conversationId: CONVERSATION_ID,
      markedCount: 2,
    });
  });
});
