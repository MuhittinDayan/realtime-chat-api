import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/database/prisma.js";
import { PrismaConversationRepository } from "./conversation.repository.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_IDS = Array.from({ length: 104 }, (_, index) =>
  `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
const [OWNER_ID, MEMBER_ID, ...CAPACITY_USER_IDS] = USER_IDS as [
  string,
  string,
  ...string[],
];
const createdConversationIds: string[] = [];
const repository = new PrismaConversationRepository(prisma);

beforeAll(async () => {
  await prisma.user.createMany({
    data: USER_IDS.map((id, index) => ({
      id,
      email: `group-test-${index}@example.com`,
      username: `group_test_${index}`,
      displayName: `Group Test ${index}`,
      passwordHash: "integration-test-only",
    })),
    skipDuplicates: true,
  });
});

afterAll(async () => {
  await prisma.conversation.deleteMany({
    where: { id: { in: createdConversationIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  await prisma.$disconnect();
});

describe("group repository against PostgreSQL", () => {
  it("reactivates the composite-PK membership row instead of inserting another", async () => {
    const group = await repository.createGroupConversation({
      creatorId: OWNER_ID,
      title: "Reactivation",
      userIds: [MEMBER_ID, CAPACITY_USER_IDS[0]!],
    });
    expect(group).not.toBeNull();
    createdConversationIds.push(group!.id);
    await expect(repository.hasActiveMembership(group!.id, MEMBER_ID)).resolves.toBe(true);
    await expect(repository.listConversations({ userId: OWNER_ID, take: 20 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: group!.id, type: "GROUP" })]),
    );

    await expect(repository.leaveGroup({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      leftAt: NOW,
    })).resolves.toEqual({ status: "ok", value: null });

    const rowCountBefore = await prisma.conversationMember.count({
      where: { conversationId: group!.id, userId: MEMBER_ID },
    });
    expect(rowCountBefore).toBe(1);

    await expect(repository.addGroupMember({
      conversationId: group!.id,
      actorId: OWNER_ID,
      userId: MEMBER_ID,
      joinedAt: new Date(NOW.getTime() + 1_000),
    })).resolves.toMatchObject({
      status: "ok",
      value: { userId: MEMBER_ID, role: "MEMBER" },
    });

    const rows = await prisma.conversationMember.findMany({
      where: { conversationId: group!.id, userId: MEMBER_ID },
      select: { leftAt: true },
    });
    expect(rows).toEqual([{ leftAt: null }]);
  });

  it("serializes concurrent additions at the 100-active-member boundary", async () => {
    const initialTargets = [MEMBER_ID, ...CAPACITY_USER_IDS.slice(0, 97)];
    const group = await repository.createGroupConversation({
      creatorId: OWNER_ID,
      title: "Capacity",
      userIds: initialTargets,
    });
    expect(group).not.toBeNull();
    createdConversationIds.push(group!.id);
    expect(group!.members).toHaveLength(99);

    const firstCandidate = CAPACITY_USER_IDS[97]!;
    const secondCandidate = CAPACITY_USER_IDS[98]!;
    const results = await Promise.all([
      repository.addGroupMember({
        conversationId: group!.id,
        actorId: OWNER_ID,
        userId: firstCandidate,
        joinedAt: NOW,
      }),
      repository.addGroupMember({
        conversationId: group!.id,
        actorId: OWNER_ID,
        userId: secondCandidate,
        joinedAt: NOW,
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "MEMBER_LIMIT",
      "ok",
    ]);
    await expect(prisma.conversationMember.count({
      where: { conversationId: group!.id, leftAt: null },
    })).resolves.toBe(100);
  });

  it("atomically demotes the previous OWNER and leaves exactly one new OWNER", async () => {
    const group = await repository.createGroupConversation({
      creatorId: OWNER_ID,
      title: "Ownership",
      userIds: [MEMBER_ID, CAPACITY_USER_IDS[0]!],
    });
    expect(group).not.toBeNull();
    createdConversationIds.push(group!.id);

    const result = await repository.transferGroupOwnership({
      conversationId: group!.id,
      actorId: OWNER_ID,
      userId: MEMBER_ID,
    });
    expect(result.status).toBe("ok");

    const roles = await prisma.conversationMember.findMany({
      where: { conversationId: group!.id, leftAt: null },
      orderBy: { userId: "asc" },
      select: { userId: true, role: true },
    });
    expect(roles.filter(({ role }) => role === "OWNER")).toEqual([
      { userId: MEMBER_ID, role: "OWNER" },
    ]);
    expect(roles).toContainEqual({ userId: OWNER_ID, role: "ADMIN" });
  });

  it("enforces the role matrix and OWNER-target protections inside locked transactions", async () => {
    const thirdMemberId = CAPACITY_USER_IDS[1]!;
    const group = await repository.createGroupConversation({
      creatorId: OWNER_ID,
      title: "Roles",
      userIds: [MEMBER_ID, thirdMemberId],
    });
    expect(group).not.toBeNull();
    createdConversationIds.push(group!.id);

    await expect(repository.updateGroupTitle({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      title: "Denied",
    })).resolves.toEqual({ status: "INSUFFICIENT_ROLE" });

    await expect(repository.updateGroupMemberRole({
      conversationId: group!.id,
      actorId: OWNER_ID,
      userId: MEMBER_ID,
      role: "ADMIN",
    })).resolves.toMatchObject({ status: "ok", value: { role: "ADMIN" } });

    await expect(repository.updateGroupTitle({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      title: "Admin renamed",
    })).resolves.toMatchObject({ status: "ok" });

    await expect(repository.updateGroupMemberRole({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      userId: thirdMemberId,
      role: "ADMIN",
    })).resolves.toEqual({ status: "INSUFFICIENT_ROLE" });

    await expect(repository.removeGroupMember({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      userId: thirdMemberId,
      leftAt: NOW,
    })).resolves.toEqual({ status: "ok", value: null });

    await expect(repository.removeGroupMember({
      conversationId: group!.id,
      actorId: MEMBER_ID,
      userId: OWNER_ID,
      leftAt: NOW,
    })).resolves.toEqual({ status: "TARGET_IS_OWNER" });

    await expect(repository.updateGroupMemberRole({
      conversationId: group!.id,
      actorId: OWNER_ID,
      userId: OWNER_ID,
      role: "ADMIN",
    })).resolves.toEqual({ status: "TARGET_IS_OWNER" });
  });

  it("allows later shrinkage but prevents the final OWNER from leaving", async () => {
    const thirdMemberId = CAPACITY_USER_IDS[2]!;
    const group = await repository.createGroupConversation({
      creatorId: OWNER_ID,
      title: "Last owner",
      userIds: [MEMBER_ID, thirdMemberId],
    });
    expect(group).not.toBeNull();
    createdConversationIds.push(group!.id);

    for (const userId of [MEMBER_ID, thirdMemberId]) {
      await expect(repository.removeGroupMember({
        conversationId: group!.id,
        actorId: OWNER_ID,
        userId,
        leftAt: NOW,
      })).resolves.toEqual({ status: "ok", value: null });
    }
    await expect(repository.leaveGroup({
      conversationId: group!.id,
      actorId: OWNER_ID,
      leftAt: NOW,
    })).resolves.toEqual({ status: "LAST_OWNER" });
  });
});
