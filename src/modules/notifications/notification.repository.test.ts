import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaNotificationRepository } from "./notification.repository.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const notification = {
  id: NOTIFICATION_ID,
  type: "MESSAGE_CREATED" as const,
  recipientUserId: USER_ID,
  conversationId: CONVERSATION_ID,
  createdAt: NOW,
  readAt: null,
  message: {
    id: MESSAGE_ID,
    kind: "TEXT" as const,
    body: "hello",
    createdAt: NOW,
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

describe("Prisma notification repository", () => {
  it("scopes descending keyset pagination to the recipient", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { notification: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaNotificationRepository(client);

    await repository.listNotifications({
      recipientUserId: USER_ID,
      cursor: { createdAt: NOW, id: NOTIFICATION_ID },
      take: 21,
    });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.where).toEqual({
      recipientUserId: USER_ID,
      OR: [
        { createdAt: { lt: NOW } },
        { createdAt: NOW, id: { lt: NOTIFICATION_ID } },
      ],
    });
    expect(query.orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
    expect(query.take).toBe(21);
  });

  it("counts only the recipient's unread notifications", async () => {
    const count = vi.fn().mockResolvedValue(3);
    const client = { notification: { count } } as unknown as PrismaClient;
    const repository = new PrismaNotificationRepository(client);

    await expect(repository.countUnread(USER_ID)).resolves.toBe(3);
    expect(count).toHaveBeenCalledWith({
      where: { recipientUserId: USER_ID, readAt: null },
    });
  });

  it("marks a notification only through its owner scope", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue({
      ...notification,
      readAt: NOW,
    });
    const transactionClient = { notification: { updateMany, findFirst } };
    const client = {
      $transaction: vi.fn(
        async (callback: (tx: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaNotificationRepository(client);

    await expect(
      repository.markRead({
        notificationId: NOTIFICATION_ID,
        recipientUserId: USER_ID,
        readAt: NOW,
      }),
    ).resolves.toMatchObject({ id: NOTIFICATION_ID, readAt: NOW });
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: NOTIFICATION_ID,
        recipientUserId: USER_ID,
        readAt: null,
      },
      data: { readAt: NOW },
    });
    expect(findFirst.mock.calls[0]?.[0].where).toEqual({
      id: NOTIFICATION_ID,
      recipientUserId: USER_ID,
    });
  });

  it("returns zero when a repeated conversation read has nothing left to mark", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 2 })
      .mockResolvedValueOnce({ count: 0 });
    const client = { notification: { updateMany } } as unknown as PrismaClient;
    const repository = new PrismaNotificationRepository(client);
    const input = {
      conversationId: CONVERSATION_ID,
      recipientUserId: USER_ID,
      readAt: NOW,
    };

    await expect(repository.markConversationRead(input)).resolves.toBe(2);
    await expect(repository.markConversationRead(input)).resolves.toBe(0);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        recipientUserId: USER_ID,
        readAt: null,
      },
      data: { readAt: NOW },
    });
  });
});
