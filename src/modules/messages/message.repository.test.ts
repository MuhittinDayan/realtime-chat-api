import { describe, expect, it, vi } from "vitest";

import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { PrismaMessageRepository } from "./message.repository.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const message = {
  id: "44444444-4444-4444-8444-444444444444",
  conversationId: CONVERSATION_ID,
  senderId: ALICE_ID,
  clientMessageId: CLIENT_MESSAGE_ID,
  kind: "TEXT" as const,
  body: "hello",
  createdAt: NOW,
  editedAt: null,
  deletedAt: null,
};

describe("Prisma message repository", () => {
  it("creates a message then advances lastMessageAt in the same transaction", async () => {
    const lifecycle: string[] = [];
    const create = vi.fn(async () => {
      lifecycle.push("create");
      return message;
    });
    const updateMany = vi.fn(async (_query: unknown) => {
      lifecycle.push("update");
      return { count: 1 };
    });
    const transactionClient = {
      message: { create },
      conversation: { updateMany },
    };
    const transaction = vi.fn(
      async (callback: (client: typeof transactionClient) => unknown) => {
        const result = await callback(transactionClient);
        lifecycle.push("commit");
        return result;
      },
    );
    const client = {
      message: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: transaction,
    } as unknown as PrismaClient;
    const repository = new PrismaMessageRepository(client);

    const result = await repository.createMessage({
      conversationId: CONVERSATION_ID,
      senderId: ALICE_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      body: "hello",
    });

    expect(result).toEqual({ message, created: true });
    expect(lifecycle).toEqual(["create", "update", "commit"]);
    expect(updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: CONVERSATION_ID,
        OR: [
          { lastMessageAt: null },
          { lastMessageAt: { lt: NOW } },
        ],
      },
      data: { lastMessageAt: NOW },
    });
  });

  it("recovers the committed message after an idempotency race", async () => {
    const uniqueError = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      {
        code: "P2002",
        clientVersion: "7.9.1",
        meta: {
          driverAdapterError: {
            cause: {
              kind: "UniqueConstraintViolation",
              constraint: {
                fields: ["sender_id", "client_message_id"],
              },
            },
          },
        },
      },
    );
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(message);
    const client = {
      message: { findUnique },
      $transaction: () => Promise.reject(uniqueError),
    } as unknown as PrismaClient;
    const repository = new PrismaMessageRepository(client);

    const result = await repository.createMessage({
      conversationId: CONVERSATION_ID,
      senderId: ALICE_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      body: "hello",
    });

    expect(result).toEqual({ message, created: false });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("uses descending keyset pagination before the supplied cursor", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { message: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaMessageRepository(client);
    const cursorId = "55555555-5555-4555-8555-555555555555";

    await repository.listMessages({
      conversationId: CONVERSATION_ID,
      before: { createdAt: NOW, id: cursorId },
      take: 51,
    });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.where).toEqual({
      conversationId: CONVERSATION_ID,
      OR: [
        { createdAt: { lt: NOW } },
        { createdAt: NOW, id: { lt: cursorId } },
      ],
    });
    expect(query.orderBy).toEqual([
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });

  it("updates only an undeleted message owned by the sender", async () => {
    const updated = { ...message, body: "updated", editedAt: NOW };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue(updated);
    const transactionClient = { message: { updateMany, findFirst } };
    const client = {
      $transaction: vi.fn(
        async (callback: (transaction: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaMessageRepository(client);

    const result = await repository.updateMessage({
      conversationId: CONVERSATION_ID,
      messageId: message.id,
      senderId: ALICE_ID,
      body: "updated",
      editedAt: NOW,
    });

    expect(result).toEqual({ message: updated, changed: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: message.id,
          conversationId: CONVERSATION_ID,
          senderId: ALICE_ID,
          deletedAt: null,
          body: { not: "updated" },
        },
        data: { body: "updated", editedAt: NOW },
      }),
    );
  });

  it("returns the existing tombstone without changing its deletion timestamp", async () => {
    const deleted = { ...message, deletedAt: NOW };
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirst = vi.fn().mockResolvedValue(deleted);
    const transactionClient = { message: { updateMany, findFirst } };
    const client = {
      $transaction: vi.fn(
        async (callback: (transaction: typeof transactionClient) => unknown) =>
          callback(transactionClient),
      ),
    } as unknown as PrismaClient;
    const repository = new PrismaMessageRepository(client);

    const result = await repository.softDeleteMessage({
      conversationId: CONVERSATION_ID,
      messageId: message.id,
      senderId: ALICE_ID,
      deletedAt: new Date(NOW.getTime() + 1_000),
    });

    expect(result).toEqual({ message: deleted, changed: false });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: message.id,
          conversationId: CONVERSATION_ID,
          senderId: ALICE_ID,
          deletedAt: null,
        },
      }),
    );
  });
});
