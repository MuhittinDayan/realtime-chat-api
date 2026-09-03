import { describe, expect, it, vi } from "vitest";

import {
  ConversationConflictError,
  ConversationNotFoundError,
  InsufficientRoleError,
} from "./conversation.errors.js";
import type {
  ConversationMemberRecord,
  ConversationRecord,
  ConversationRepository,
  GroupMutationFailure,
} from "./conversation.repository.js";
import {
  ConversationService,
  type GroupPublisher,
} from "./conversation.service.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const targetMember: ConversationMemberRecord = {
  userId: TARGET_ID,
  role: "MEMBER",
  joinedAt: NOW,
  user: {
    id: TARGET_ID,
    username: "target",
    displayName: "Target",
    avatarUrl: null,
  },
};

const groupRecord: ConversationRecord = {
  id: CONVERSATION_ID,
  type: "GROUP",
  title: "Core team",
  lastMessageAt: null,
  createdAt: NOW,
  members: [
    {
      userId: OWNER_ID,
      role: "OWNER",
      joinedAt: NOW,
      user: {
        id: OWNER_ID,
        username: "owner",
        displayName: "Owner",
        avatarUrl: null,
      },
    },
    targetMember,
  ],
};

function ok<T>(value: T) {
  return { status: "ok" as const, value };
}

function failed(status: GroupMutationFailure) {
  return { status } as const;
}

function createRepository(): ConversationRepository {
  return {
    hasActiveMembership: vi.fn().mockResolvedValue(true),
    findAvailableUser: vi.fn().mockResolvedValue(targetMember.user),
    findDirectConversationByKey: vi.fn().mockResolvedValue(null),
    createDirectConversation: vi.fn(),
    createGroupConversation: vi.fn().mockResolvedValue(groupRecord),
    listConversations: vi.fn().mockResolvedValue([]),
    findConversationForMember: vi.fn().mockResolvedValue(groupRecord),
    updateMute: vi.fn().mockResolvedValue(true),
    updateGroupTitle: vi.fn().mockResolvedValue(ok(groupRecord)),
    addGroupMember: vi.fn().mockResolvedValue(ok(targetMember)),
    removeGroupMember: vi.fn().mockResolvedValue(ok(null)),
    leaveGroup: vi.fn().mockResolvedValue(ok(null)),
    updateGroupMemberRole: vi.fn().mockResolvedValue(ok({ ...targetMember, role: "ADMIN" })),
    transferGroupOwnership: vi.fn().mockResolvedValue(ok({
      ...groupRecord,
      members: [
        { ...groupRecord.members[0]!, role: "ADMIN" },
        { ...targetMember, role: "OWNER" },
      ],
    })),
  };
}

function createPublisher(): GroupPublisher {
  return {
    publishGroupCreated: vi.fn(),
    publishGroupUpdated: vi.fn(),
    publishMemberAdded: vi.fn(),
    publishMemberRemoved: vi.fn(),
    publishMemberLeft: vi.fn(),
    publishMemberRoleUpdated: vi.fn(),
    publishOwnershipTransferred: vi.fn(),
  };
}

function createSubject() {
  const repository = createRepository();
  const publisher = createPublisher();
  const service = new ConversationService(repository, publisher, {
    now: () => NOW,
  });
  return { repository, publisher, service };
}

describe("group conversation service role and lifecycle rules", () => {
  it("lets any authenticated user create a group and makes repository output visible", async () => {
    const { repository, publisher, service } = createSubject();
    const result = await service.createGroupConversation(MEMBER_ID, {
      title: "Core team",
      userIds: [ADMIN_ID, TARGET_ID],
    });

    expect(result.type).toBe("GROUP");
    expect(repository.createGroupConversation).toHaveBeenCalledWith({
      creatorId: MEMBER_ID,
      title: "Core team",
      userIds: [ADMIN_ID, TARGET_ID],
    });
    expect(publisher.publishGroupCreated).toHaveBeenCalledWith(result);
  });

  it.each([OWNER_ID, ADMIN_ID])("allows manager %s to update the title", async (actorId) => {
    const { service, publisher } = createSubject();
    await expect(service.updateGroupTitle(actorId, CONVERSATION_ID, { title: "Renamed" })).resolves.toMatchObject({ type: "GROUP" });
    expect(publisher.publishGroupUpdated).toHaveBeenCalledOnce();
  });

  it("maps a MEMBER title update denial to the exact 403 contract", async () => {
    const { repository, service } = createSubject();
    vi.mocked(repository.updateGroupTitle).mockResolvedValue(failed("INSUFFICIENT_ROLE"));
    await expect(service.updateGroupTitle(MEMBER_ID, CONVERSATION_ID, { title: "Nope" })).rejects.toMatchObject({
      statusCode: 403,
      code: "INSUFFICIENT_ROLE",
      message: "Your role does not permit this action",
    });
  });

  it.each([OWNER_ID, ADMIN_ID])("allows manager %s to add a member", async (actorId) => {
    const { service, publisher } = createSubject();
    await expect(service.addGroupMember(actorId, CONVERSATION_ID, { userId: TARGET_ID })).resolves.toMatchObject({ userId: TARGET_ID, role: "MEMBER" });
    expect(publisher.publishMemberAdded).toHaveBeenCalledOnce();
  });

  it.each(["ALREADY_ACTIVE", "MEMBER_LIMIT"] as const)("returns 409 for add conflict %s", async (status) => {
    const { repository, service } = createSubject();
    vi.mocked(repository.addGroupMember).mockResolvedValue(failed(status));
    await expect(service.addGroupMember(OWNER_ID, CONVERSATION_ID, { userId: TARGET_ID })).rejects.toBeInstanceOf(ConversationConflictError);
  });

  it.each([OWNER_ID, ADMIN_ID])("allows manager %s to remove a non-owner", async (actorId) => {
    const { service, publisher } = createSubject();
    await service.removeGroupMember(actorId, CONVERSATION_ID, TARGET_ID);
    expect(publisher.publishMemberRemoved).toHaveBeenCalledWith(CONVERSATION_ID, TARGET_ID);
  });

  it("rejects direct self-removal and points to /members/me", async () => {
    const { repository, service } = createSubject();
    vi.mocked(repository.removeGroupMember).mockResolvedValue(failed("SAME_USER"));
    await expect(service.removeGroupMember(ADMIN_ID, CONVERSATION_ID, ADMIN_ID)).rejects.toMatchObject({
      statusCode: 400,
      message: "Use /members/me to leave the group",
    });
  });

  it.each(["removeGroupMember", "updateGroupMemberRole"] as const)("rejects targeting OWNER through %s with 409", async (method) => {
    const { repository, service } = createSubject();
    vi.mocked(repository[method]).mockResolvedValue(failed("TARGET_IS_OWNER"));
    const action = method === "removeGroupMember"
      ? service.removeGroupMember(OWNER_ID, CONVERSATION_ID, OWNER_ID)
      : service.updateGroupMemberRole(OWNER_ID, CONVERSATION_ID, OWNER_ID, { role: "ADMIN" });
    await expect(action).rejects.toMatchObject({ statusCode: 409, code: "CONFLICT", message: "Ownership must be transferred first" });
  });

  it("allows only OWNER to change MEMBER/ADMIN roles", async () => {
    const { repository, service } = createSubject();
    await expect(service.updateGroupMemberRole(OWNER_ID, CONVERSATION_ID, TARGET_ID, { role: "ADMIN" })).resolves.toMatchObject({ role: "ADMIN" });
    vi.mocked(repository.updateGroupMemberRole).mockResolvedValue(failed("INSUFFICIENT_ROLE"));
    await expect(service.updateGroupMemberRole(ADMIN_ID, CONVERSATION_ID, TARGET_ID, { role: "MEMBER" })).rejects.toBeInstanceOf(InsufficientRoleError);
  });

  it("transfers ownership atomically shaped as old ADMIN and new OWNER and rejects ADMIN", async () => {
    const { repository, publisher, service } = createSubject();
    const transferred = await service.transferGroupOwnership(OWNER_ID, CONVERSATION_ID, { userId: TARGET_ID });
    expect(transferred.members.map(({ userId, role }) => ({ userId, role }))).toEqual([
      { userId: OWNER_ID, role: "ADMIN" },
      { userId: TARGET_ID, role: "OWNER" },
    ]);
    expect(publisher.publishOwnershipTransferred).toHaveBeenCalledWith(transferred, OWNER_ID, TARGET_ID);
    vi.mocked(repository.transferGroupOwnership).mockResolvedValue(failed("INSUFFICIENT_ROLE"));
    await expect(service.transferGroupOwnership(ADMIN_ID, CONVERSATION_ID, { userId: TARGET_ID })).rejects.toBeInstanceOf(InsufficientRoleError);
  });

  it.each([ADMIN_ID, MEMBER_ID, OWNER_ID])("allows active actor %s to leave when repository permits it", async (actorId) => {
    const { service, publisher } = createSubject();
    await service.leaveGroup(actorId, CONVERSATION_ID);
    expect(publisher.publishMemberLeft).toHaveBeenCalledWith(CONVERSATION_ID, actorId);
  });

  it("blocks the last OWNER from leaving", async () => {
    const { repository, service } = createSubject();
    vi.mocked(repository.leaveGroup).mockResolvedValue(failed("LAST_OWNER"));
    await expect(service.leaveGroup(OWNER_ID, CONVERSATION_ID)).rejects.toBeInstanceOf(ConversationConflictError);
  });

  it("hides missing groups and inactive actors behind CONVERSATION_NOT_FOUND", async () => {
    const { repository, service } = createSubject();
    vi.mocked(repository.updateGroupTitle).mockResolvedValue(failed("CONVERSATION_NOT_FOUND"));
    await expect(service.updateGroupTitle(MEMBER_ID, CONVERSATION_ID, { title: "Hidden" })).rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("uses the shared membership check without a conversation-type parameter", async () => {
    const { repository, service } = createSubject();
    await expect(service.isActiveMember(CONVERSATION_ID, MEMBER_ID)).resolves.toBe(true);
    expect(repository.hasActiveMembership).toHaveBeenCalledWith(CONVERSATION_ID, MEMBER_ID);
  });
});
