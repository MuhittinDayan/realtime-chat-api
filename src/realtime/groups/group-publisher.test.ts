import { describe, expect, it, vi } from "vitest";

import type {
  GroupConversationDto,
  GroupMemberDto,
} from "../../modules/conversations/conversation.service.js";
import { SocketGroupPublisher } from "./group-publisher.js";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const owner: GroupMemberDto = {
  userId: OWNER_ID,
  role: "OWNER",
  joinedAt: NOW,
  user: {
    id: OWNER_ID,
    username: "owner",
    displayName: "Owner",
    avatarUrl: null,
  },
};

const member: GroupMemberDto = {
  userId: MEMBER_ID,
  role: "MEMBER",
  joinedAt: NOW,
  user: {
    id: MEMBER_ID,
    username: "member",
    displayName: "Member",
    avatarUrl: null,
  },
};

const conversation: GroupConversationDto = {
  id: CONVERSATION_ID,
  type: "GROUP",
  title: "Core team",
  createdAt: NOW,
  members: [owner, member],
};

describe("SocketGroupPublisher", () => {
  it("publishes group creation to every member's user room", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const publisher = new SocketGroupPublisher();
    publisher.bind({ to } as never);

    publisher.publishGroupCreated(conversation);

    expect(to).toHaveBeenCalledOnce();
    expect(to).toHaveBeenCalledWith([
      `user:${OWNER_ID}`,
      `user:${MEMBER_ID}`,
    ]);
    expect(emit).toHaveBeenCalledWith("group:created", {
      conversation: {
        ...conversation,
        createdAt: NOW.toISOString(),
        members: [
          { ...owner, joinedAt: NOW.toISOString() },
          { ...member, joinedAt: NOW.toISOString() },
        ],
      },
    });
  });

  it("publishes member addition to the conversation and new member user rooms", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const publisher = new SocketGroupPublisher();
    publisher.bind({ to } as never);

    publisher.publishMemberAdded(CONVERSATION_ID, member);

    expect(to).toHaveBeenCalledOnce();
    expect(to).toHaveBeenCalledWith([
      `conversation:${CONVERSATION_ID}`,
      `user:${MEMBER_ID}`,
    ]);
    expect(emit).toHaveBeenCalledWith("member:added", {
      conversationId: CONVERSATION_ID,
      member: { ...member, joinedAt: NOW.toISOString() },
    });
  });

  it("keeps the remaining lifecycle events scoped to the conversation room", () => {
    const emit = vi.fn();
    const socketsLeave = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const inRoom = vi.fn(() => ({ socketsLeave }));
    const publisher = new SocketGroupPublisher();
    publisher.bind({ to, in: inRoom } as never);

    publisher.publishGroupUpdated(conversation);
    publisher.publishMemberRoleUpdated(CONVERSATION_ID, {
      ...member,
      role: "ADMIN",
    });
    publisher.publishOwnershipTransferred(
      conversation,
      OWNER_ID,
      MEMBER_ID,
    );
    publisher.publishMemberRemoved(CONVERSATION_ID, MEMBER_ID);
    publisher.publishMemberLeft(CONVERSATION_ID, MEMBER_ID);

    expect(to).toHaveBeenCalledTimes(5);
    for (let call = 1; call <= 5; call += 1) {
      expect(to).toHaveBeenNthCalledWith(
        call,
        `conversation:${CONVERSATION_ID}`,
      );
    }
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      "group:updated",
      "member:role-updated",
      "ownership:transferred",
      "member:removed",
      "member:left",
    ]);
    expect(inRoom).toHaveBeenCalledTimes(2);
    expect(inRoom).toHaveBeenCalledWith(`user:${MEMBER_ID}`);
    expect(socketsLeave).toHaveBeenCalledTimes(2);
    expect(socketsLeave).toHaveBeenCalledWith(
      `conversation:${CONVERSATION_ID}`,
    );
  });
});
