import { describe, expect, it } from "vitest";

import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import type {
  CreateMessageRepositoryInput,
  CreateMessageRepositoryResult,
  ListMessagesRepositoryInput,
  MessageRecord,
  MessageRepository,
} from "./message.repository.js";
import { messageHistoryQuerySchema } from "./message.schema.js";
import {
  MessageService,
  type ConversationAccessService,
  type MessageDto,
  type MessagePublisher,
} from "./message.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

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
  };
}

class InMemoryMessageRepository implements MessageRepository {
  readonly records: MessageRecord[] = [];
  createCount = 0;
  readonly lifecycle: string[];

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
      return { message: existing, created: false };
    }

    this.createCount += 1;
    const message: MessageRecord = {
      ...createRecord(this.createCount),
      conversationId: input.conversationId,
      senderId: input.senderId,
      clientMessageId: input.clientMessageId,
      body: input.body,
    };
    this.records.push(message);
    this.lifecycle.push("commit");
    return { message, created: true };
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
}

class FakeConversationAccess implements ConversationAccessService {
  constructor(readonly allowed: boolean) {}

  async isActiveMember(): Promise<boolean> {
    return this.allowed;
  }
}

class RecordingPublisher implements MessagePublisher {
  readonly messages: MessageDto[] = [];

  constructor(private readonly lifecycle: string[] = []) {}

  publishMessageCreated(message: MessageDto): void {
    this.lifecycle.push("publish");
    this.messages.push(message);
  }
}

describe("message service creation", () => {
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
