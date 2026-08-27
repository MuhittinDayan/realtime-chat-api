import { describe, expect, it } from "vitest";

import {
  CannotMessageSelfError,
  ConversationNotFoundError,
  UserNotFoundError,
} from "./conversation.errors.js";
import {
  DirectConversationUniqueConstraintError,
  type ConversationRepository,
  type ConversationRecord,
  type ConversationUserRecord,
  type DirectConversationRecord,
  type ListedDirectConversationRecord,
  type ListConversationsRepositoryInput,
} from "./conversation.repository.js";
import { ConversationService } from "./conversation.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CAROL_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2030-01-01T00:00:00.000Z");

interface StoredUser {
  publicUser: ConversationUserRecord;
  active: boolean;
  deleted: boolean;
}

const alice: StoredUser = {
  publicUser: {
    id: ALICE_ID,
    username: "alice",
    displayName: "Alice",
    avatarUrl: null,
  },
  active: true,
  deleted: false,
};
const bob: StoredUser = {
  publicUser: {
    id: BOB_ID,
    username: "bob",
    displayName: "Bob",
    avatarUrl: null,
  },
  active: true,
  deleted: false,
};

class InMemoryConversationRepository implements ConversationRepository {
  readonly users = new Map<string, StoredUser>();
  readonly conversations = new Map<string, DirectConversationRecord>();
  readonly activeMembers = new Map<string, Set<string>>();
  createCalls = 0;
  createdMemberships: readonly string[] = [];

  constructor(users: readonly StoredUser[] = [alice, bob]) {
    for (const user of users) {
      this.users.set(user.publicUser.id, user);
    }
  }

  async hasActiveMembership(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    return this.activeMembers.get(conversationId)?.has(userId) ?? false;
  }

  async findAvailableUser(
    userId: string,
  ): Promise<ConversationUserRecord | null> {
    const user = this.users.get(userId);
    return user !== undefined && user.active && !user.deleted
      ? user.publicUser
      : null;
  }

  async findDirectConversationByKey(
    directKey: string,
  ): Promise<DirectConversationRecord | null> {
    return this.conversations.get(directKey) ?? null;
  }

  async createDirectConversation(input: {
    currentUserId: string;
    targetUserId: string;
    directKey: string;
  }): Promise<DirectConversationRecord> {
    this.createCalls += 1;
    await Promise.resolve();

    if (this.conversations.has(input.directKey)) {
      throw new DirectConversationUniqueConstraintError(
        new Error("simulated unique conflict"),
      );
    }

    const target = this.users.get(input.targetUserId);
    if (target === undefined) {
      throw new Error("Missing fixture user");
    }

    const record: DirectConversationRecord = {
      id: CONVERSATION_ID,
      type: "DIRECT",
      title: null,
      lastMessageAt: null,
      createdAt: NOW,
      members: [{
        userId: target.publicUser.id,
        role: "MEMBER",
        joinedAt: NOW,
        user: target.publicUser,
      }],
    };
    this.createdMemberships = [input.currentUserId, input.targetUserId];
    this.activeMembers.set(
      record.id,
      new Set(this.createdMemberships),
    );
    this.conversations.set(input.directKey, record);
    return record;
  }

  async listConversations(
    input: ListConversationsRepositoryInput,
  ): Promise<readonly ListedDirectConversationRecord[]> {
    return [...this.conversations.values()]
      .filter((conversation) =>
        this.activeMembers.get(conversation.id)?.has(input.userId),
      )
      .slice(0, input.take)
      .map((conversation) => ({
        ...conversation,
        lastMessage: null,
        unreadCount: 0,
      }));
  }

  async findConversationForMember(
    conversationId: string,
    userId: string,
  ): Promise<DirectConversationRecord | null> {
    if (!this.activeMembers.get(conversationId)?.has(userId)) {
      return null;
    }

    for (const conversation of this.conversations.values()) {
      if (conversation.id === conversationId) {
        return conversation;
      }
    }

    return null;
  }

  async createGroupConversation(): Promise<ConversationRecord | null> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async updateGroupTitle(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async addGroupMember(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async removeGroupMember(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async leaveGroup(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async updateGroupMemberRole(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }

  async transferGroupOwnership(): Promise<never> {
    throw new Error("Not implemented by direct-conversation test double");
  }
}

describe("direct conversation service", () => {
  it("creates a direct conversation with both memberships", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);

    const result = await service.getOrCreateDirectConversation(
      ALICE_ID,
      BOB_ID,
    );

    expect(result.created).toBe(true);
    expect(result.conversation).toEqual({
      id: CONVERSATION_ID,
      type: "DIRECT",
      title: null,
      createdAt: NOW,
      otherUser: bob.publicUser,
    });
    expect(repository.createdMemberships).toEqual([ALICE_ID, BOB_ID]);
  });

  it("returns the same conversation on a later request", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);

    const first = await service.getOrCreateDirectConversation(
      ALICE_ID,
      BOB_ID,
    );
    const second = await service.getOrCreateDirectConversation(
      ALICE_ID,
      BOB_ID,
    );

    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.created).toBe(false);
    expect(repository.createCalls).toBe(1);
  });

  it("converges concurrent creates on the same conversation id", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);

    const [first, second] = await Promise.all([
      service.getOrCreateDirectConversation(ALICE_ID, BOB_ID),
      service.getOrCreateDirectConversation(BOB_ID, ALICE_ID),
    ]);

    expect(first.conversation.id).toBe(CONVERSATION_ID);
    expect(second.conversation.id).toBe(CONVERSATION_ID);
    expect(repository.createCalls).toBe(2);
    expect([first.created, second.created].sort()).toEqual([false, true]);
  });

  it("rejects a self conversation", async () => {
    const service = new ConversationService(
      new InMemoryConversationRepository(),
    );

    await expect(
      service.getOrCreateDirectConversation(ALICE_ID, ALICE_ID),
    ).rejects.toBeInstanceOf(CannotMessageSelfError);
  });

  it("rejects a self conversation expressed with uppercase UUID hex", async () => {
    const service = new ConversationService(
      new InMemoryConversationRepository(),
    );

    await expect(
      service.getOrCreateDirectConversation(
        ALICE_ID,
        ALICE_ID.toUpperCase(),
      ),
    ).rejects.toBeInstanceOf(CannotMessageSelfError);
  });

  it.each([
    ["unknown", undefined],
    ["disabled", { ...bob, active: false }],
    ["deleted", { ...bob, deleted: true }],
  ] as const)("hides a %s target as USER_NOT_FOUND", async (_case, target) => {
    const repository = new InMemoryConversationRepository(
      target === undefined ? [alice] : [alice, target],
    );
    const service = new ConversationService(repository);

    await expect(
      service.getOrCreateDirectConversation(ALICE_ID, BOB_ID),
    ).rejects.toBeInstanceOf(UserNotFoundError);
  });
});

describe("conversation list and detail service", () => {
  it("returns the other user and creates an opaque pagination cursor", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);
    const firstRecord = await repository.createDirectConversation({
      currentUserId: ALICE_ID,
      targetUserId: BOB_ID,
      directKey: `${ALICE_ID}:${BOB_ID}`,
    });
    const secondRecord: DirectConversationRecord = {
      ...firstRecord,
      id: SECOND_CONVERSATION_ID,
      createdAt: new Date(NOW.getTime() - 1_000),
    };
    repository.conversations.set("second", secondRecord);
    repository.activeMembers.set(
      SECOND_CONVERSATION_ID,
      new Set([ALICE_ID, BOB_ID]),
    );

    const result = await service.listConversations(ALICE_ID, { limit: 1 });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.type).toBe("DIRECT");
    if (item?.type !== "DIRECT") throw new Error("Expected DIRECT fixture");
    expect(item.otherUser).toEqual(bob.publicUser);
    expect(result.nextCursor).not.toBeNull();
  });

  it("does not return a conversation owned only by another user", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);
    await repository.createDirectConversation({
      currentUserId: ALICE_ID,
      targetUserId: BOB_ID,
      directKey: `${ALICE_ID}:${BOB_ID}`,
    });

    const result = await service.listConversations(CAROL_ID, { limit: 20 });

    expect(result.items).toEqual([]);
  });

  it("allows an active member to read a conversation", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);
    await repository.createDirectConversation({
      currentUserId: ALICE_ID,
      targetUserId: BOB_ID,
      directKey: `${ALICE_ID}:${BOB_ID}`,
    });

    const conversation = await service.getConversation(
      ALICE_ID,
      CONVERSATION_ID,
    );

    expect(conversation.id).toBe(CONVERSATION_ID);
    expect(conversation.type).toBe("DIRECT");
    if (conversation.type !== "DIRECT") throw new Error("Expected DIRECT fixture");
    expect(conversation.otherUser.id).toBe(BOB_ID);
  });

  it("returns the same not-found error to a non-member", async () => {
    const repository = new InMemoryConversationRepository();
    const service = new ConversationService(repository);
    await repository.createDirectConversation({
      currentUserId: ALICE_ID,
      targetUserId: BOB_ID,
      directKey: `${ALICE_ID}:${BOB_ID}`,
    });

    await expect(
      service.getConversation(CAROL_ID, CONVERSATION_ID),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
  });
});
