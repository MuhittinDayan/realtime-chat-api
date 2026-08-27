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
  members: [member],
};

describe("SocketGroupPublisher", () => {
  it("publishes every group event only to the conversation room", () => {
    const emit = vi.fn();
    const socketsLeave = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const inRoom = vi.fn(() => ({ socketsLeave }));
    const publisher = new SocketGroupPublisher();
    publisher.bind({ to, in: inRoom } as never);

    publisher.publishGroupCreated(conversation);
    publisher.publishGroupUpdated(conversation);
    publisher.publishMemberAdded(CONVERSATION_ID, member);
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

    expect(to).toHaveBeenCalledTimes(7);
    expect(to).toHaveBeenCalledWith(`conversation:${CONVERSATION_ID}`);
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      "group:created",
      "group:updated",
      "member:added",
      "member:role-updated",
      "ownership:transferred",
      "member:removed",
      "member:left",
    ]);
    expect(emit).toHaveBeenCalledWith("group:created", {
      conversation: {
        ...conversation,
        createdAt: NOW.toISOString(),
        members: [{ ...member, joinedAt: NOW.toISOString() }],
      },
    });
    expect(inRoom).toHaveBeenCalledTimes(2);
    expect(inRoom).toHaveBeenCalledWith(`user:${MEMBER_ID}`);
    expect(socketsLeave).toHaveBeenCalledTimes(2);
    expect(socketsLeave).toHaveBeenCalledWith(
      `conversation:${CONVERSATION_ID}`,
    );
  });
});
