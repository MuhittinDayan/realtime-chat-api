import { describe, expect, it } from "vitest";

import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { RequestValidationError } from "../../shared/errors/request-validation-error.js";
import type { ConversationAccessService } from "../messages/message.service.js";
import type {
  ReadRepository,
  ReadWatermarkMutationResult,
  UpdateReadWatermarkRepositoryInput,
} from "./read.repository.js";
import {
  ReadService,
  type ReadPublisher,
  type ReadUpdatedEvent,
} from "./read.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const FIRST_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_ID = "44444444-4444-4444-8444-444444444444";
const THIRD_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2030-01-01T00:00:00.000Z");

interface OrderedMessage {
  conversationId: string;
  createdAt: Date;
}

class AtomicInMemoryReadRepository implements ReadRepository {
  readonly messages = new Map<string, OrderedMessage>();
  private watermark: { messageId: string; readAt: Date } | null = null;
  private clockTick = 0;

  async updateWatermark(
    input: UpdateReadWatermarkRepositoryInput,
  ): Promise<ReadWatermarkMutationResult> {
    await Promise.resolve();
    const target = this.messages.get(input.throughMessageId);
    const targetExists = target?.conversationId === input.conversationId;
    const previous = this.watermark;

    if (targetExists && target !== undefined) {
      const currentMessage =
        previous === null ? null : this.messages.get(previous.messageId);

      if (
        previous === null ||
        currentMessage === null ||
        currentMessage === undefined ||
        compareMessageOrder(
          target.createdAt,
          input.throughMessageId,
          currentMessage.createdAt,
          previous.messageId,
        ) > 0
      ) {
        this.clockTick += 1;
        this.watermark = {
          messageId: input.throughMessageId,
          readAt: new Date(NOW.getTime() + this.clockTick),
        };
      }
    }

    return {
      targetExists,
      previousMessageId: previous?.messageId ?? null,
      previousReadAt: previous?.readAt ?? null,
      currentMessageId: this.watermark?.messageId ?? null,
      currentReadAt: this.watermark?.readAt ?? null,
    };
  }
}

class FakeAccessService implements ConversationAccessService {
  constructor(private readonly allowed: boolean) {}

  async isActiveMember(): Promise<boolean> {
    return this.allowed;
  }
}

class RecordingReadPublisher implements ReadPublisher {
  readonly events: ReadUpdatedEvent[] = [];

  publishReadUpdated(event: ReadUpdatedEvent): void {
    this.events.push(event);
  }
}

function createHarness(allowed = true) {
  const repository = new AtomicInMemoryReadRepository();
  repository.messages.set(FIRST_ID, {
    conversationId: CONVERSATION_ID,
    createdAt: NOW,
  });
  repository.messages.set(SECOND_ID, {
    conversationId: CONVERSATION_ID,
    createdAt: new Date(NOW.getTime() + 1_000),
  });
  repository.messages.set(THIRD_ID, {
    conversationId: CONVERSATION_ID,
    createdAt: new Date(NOW.getTime() + 1_000),
  });
  const publisher = new RecordingReadPublisher();
  const service = new ReadService(
    repository,
    new FakeAccessService(allowed),
    publisher,
  );
  return { service, repository, publisher };
}

describe("read watermark service", () => {
  it("creates the first watermark and emits", async () => {
    const { service, publisher } = createHarness();

    const result = await service.updateWatermark(
      ALICE_ID,
      CONVERSATION_ID,
      FIRST_ID,
    );

    expect(result.status).toBe("created");
    expect(result.throughMessageId).toBe(FIRST_ID);
    expect(publisher.events).toHaveLength(1);
  });

  it("advances a watermark and emits", async () => {
    const { service, publisher } = createHarness();
    await service.updateWatermark(ALICE_ID, CONVERSATION_ID, FIRST_ID);

    const result = await service.updateWatermark(
      ALICE_ID,
      CONVERSATION_ID,
      SECOND_ID,
    );

    expect(result.status).toBe("advanced");
    expect(result.throughMessageId).toBe(SECOND_ID);
    expect(publisher.events).toHaveLength(2);
  });

  it.each(["same", "older"] as const)(
    "keeps readAt and does not emit for an unchanged %s watermark",
    async (kind) => {
      const { service, publisher } = createHarness();
      const first = await service.updateWatermark(
        ALICE_ID,
        CONVERSATION_ID,
        SECOND_ID,
      );
      const unchanged = await service.updateWatermark(
        ALICE_ID,
        CONVERSATION_ID,
        kind === "same" ? SECOND_ID : FIRST_ID,
      );

      expect(unchanged.status).toBe("unchanged");
      expect(unchanged.throughMessageId).toBe(SECOND_ID);
      expect(unchanged.readAt).toEqual(first.readAt);
      expect(publisher.events).toHaveLength(1);
    },
  );

  it("uses id as the tie-break when createdAt is equal", async () => {
    const { service } = createHarness();
    await service.updateWatermark(ALICE_ID, CONVERSATION_ID, SECOND_ID);

    const result = await service.updateWatermark(
      ALICE_ID,
      CONVERSATION_ID,
      THIRD_ID,
    );

    expect(result.status).toBe("advanced");
    expect(result.throughMessageId).toBe(THIRD_ID);
  });

  it("never regresses under concurrent updates", async () => {
    const { service } = createHarness();

    await Promise.all([
      service.updateWatermark(ALICE_ID, CONVERSATION_ID, THIRD_ID),
      service.updateWatermark(ALICE_ID, CONVERSATION_ID, FIRST_ID),
    ]);
    const result = await service.updateWatermark(
      ALICE_ID,
      CONVERSATION_ID,
      FIRST_ID,
    );

    expect(result.throughMessageId).toBe(THIRD_ID);
    expect(result.status).toBe("unchanged");
  });

  it("rejects a message from another conversation", async () => {
    const { service, repository } = createHarness();
    repository.messages.set(FIRST_ID, {
      conversationId: "99999999-9999-4999-8999-999999999999",
      createdAt: NOW,
    });

    await expect(
      service.updateWatermark(ALICE_ID, CONVERSATION_ID, FIRST_ID),
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("hides the conversation from a non-member", async () => {
    const { service } = createHarness(false);

    await expect(
      service.updateWatermark(ALICE_ID, CONVERSATION_ID, FIRST_ID),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});

function compareMessageOrder(
  firstCreatedAt: Date,
  firstId: string,
  secondCreatedAt: Date,
  secondId: string,
): number {
  return (
    firstCreatedAt.getTime() - secondCreatedAt.getTime() ||
    firstId.localeCompare(secondId)
  );
}
