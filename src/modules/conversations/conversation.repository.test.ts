import { describe, expect, it, vi } from "vitest";

import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import {
  DirectConversationUniqueConstraintError,
  PrismaConversationRepository,
} from "./conversation.repository.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const record = {
  id: "44444444-4444-4444-8444-444444444444",
  type: "DIRECT" as const,
  title: null,
  lastMessageAt: null,
  createdAt: NOW,
  members: [
    {
      user: {
        id: BOB_ID,
        username: "bob",
        displayName: "Bob",
        avatarUrl: null,
      },
    },
  ],
};

describe("Prisma conversation repository", () => {
  it("checks only active membership rows", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      conversationId: "44444444-4444-4444-8444-444444444444",
    });
    const client = {
      conversationMember: { findFirst },
    } as unknown as PrismaClient;
    const repository = new PrismaConversationRepository(client);

    await expect(
      repository.hasActiveMembership(
        "44444444-4444-4444-8444-444444444444",
        ALICE_ID,
      ),
    ).resolves.toBe(true);
    expect(findFirst.mock.calls[0]?.[0].where).toEqual({
      conversationId: "44444444-4444-4444-8444-444444444444",
      userId: ALICE_ID,
      leftAt: null,
    });
  });

  it("creates the conversation and both MEMBER rows in one transaction", async () => {
    const create = vi.fn().mockResolvedValue(record);
    const transactionClient = { conversation: { create } };
    const transaction = vi.fn(async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient),
    );
    const client = { $transaction: transaction } as unknown as PrismaClient;
    const repository = new PrismaConversationRepository(client);

    await repository.createDirectConversation({
      currentUserId: ALICE_ID,
      targetUserId: BOB_ID,
      directKey: `${ALICE_ID}:${BOB_ID}`,
    });

    expect(transaction).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].data).toEqual({
      type: "DIRECT",
      directKey: `${ALICE_ID}:${BOB_ID}`,
      createdById: ALICE_ID,
      members: {
        create: [
          { userId: ALICE_ID, role: "MEMBER" },
          { userId: BOB_ID, role: "MEMBER" },
        ],
      },
    });
  });

  it("maps a direct_key P2002 conflict for service-level recovery", async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "7.9.1",
        meta: {
          driverAdapterError: {
            cause: {
              kind: "UniqueConstraintViolation",
              constraint: { fields: ["direct_key"] },
            },
          },
        },
      },
    );
    const client = {
      $transaction: () => Promise.reject(uniqueError),
    } as unknown as PrismaClient;
    const repository = new PrismaConversationRepository(client);

    await expect(
      repository.createDirectConversation({
        currentUserId: ALICE_ID,
        targetUserId: BOB_ID,
        directKey: `${ALICE_ID}:${BOB_ID}`,
      }),
    ).rejects.toBeInstanceOf(DirectConversationUniqueConstraintError);
  });

  it("lists only active memberships with the required keyset order", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = {
      conversation: { findMany },
    } as unknown as PrismaClient;
    const repository = new PrismaConversationRepository(client);

    await repository.listConversations({ userId: ALICE_ID, take: 21 });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.where).not.toHaveProperty("type");
    expect(query.where.members.some).toEqual({
      userId: ALICE_ID,
      leftAt: null,
    });
    expect(query.orderBy).toEqual([
      { lastMessageAt: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
    expect(query.take).toBe(21);
  });

  it("loads lastMessage and unreadCount for the page in one batch query", async () => {
    const secondConversationId =
      "77777777-7777-4777-8777-777777777777";
    const baseConversation = {
      ...record,
      members: record.members,
    };
    const findMany = vi.fn().mockResolvedValue([
      baseConversation,
      { ...baseConversation, id: secondConversationId },
    ]);
    const lastMessageId = "88888888-8888-4888-8888-888888888888";
    const queryRaw = vi.fn(async (_query: unknown) => [
      {
        conversationId: record.id,
        lastMessageId,
        lastMessageBody: "latest message",
        lastMessageSenderId: BOB_ID,
        lastMessageCreatedAt: NOW,
        lastMessageDeletedAt: null,
        unreadCount: 2,
      },
      {
        conversationId: secondConversationId,
        lastMessageId: null,
        lastMessageBody: null,
        lastMessageSenderId: null,
        lastMessageCreatedAt: null,
        lastMessageDeletedAt: null,
        unreadCount: 0,
      },
    ]);
    const client = {
      conversation: { findMany },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient;
    const repository = new PrismaConversationRepository(client);

    const conversations = await repository.listConversations({
      userId: ALICE_ID,
      take: 21,
    });

    expect(queryRaw).toHaveBeenCalledOnce();
    expect(conversations[0]?.lastMessage).toEqual({
      id: lastMessageId,
      body: "latest message",
      senderId: BOB_ID,
      createdAt: NOW,
      deletedAt: null,
    });
    expect(conversations[0]?.unreadCount).toBe(2);
    expect(conversations[1]?.lastMessage).toBeNull();
    expect(conversations[1]?.unreadCount).toBe(0);
    const query = queryRaw.mock.calls[0]?.[0] as { sql: string };
    expect(query.sql).toContain("unread_message.sender_id <>");
    expect(query.sql).toContain("watermark_message.id IS NULL");
    expect(query.sql).toContain(
      "unread_message.created_at, unread_message.id",
    );
    expect(query.sql).toContain("ORDER BY created_at DESC, id DESC");
  });
});
