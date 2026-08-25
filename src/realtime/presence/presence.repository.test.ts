import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaPresenceRepository } from "./presence.repository.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";

describe("Prisma presence repository", () => {
  it("bulk-loads only active direct-conversation peers", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: BOB_ID, lastSeenAt: null },
    ]);
    const client = { user: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaPresenceRepository(client);

    await repository.findAuthorizedUsers(ALICE_ID, [BOB_ID]);

    const query = findMany.mock.calls[0]?.[0];
    expect(query.where.id).toEqual({ in: [BOB_ID], not: ALICE_ID });
    expect(
      query.where.conversationMembers.some.conversation.type,
    ).toBe("DIRECT");
    expect(
      query.where.conversationMembers.some.conversation.members.some,
    ).toEqual({ userId: ALICE_ID, leftAt: null });
    expect(query.select).toEqual({ id: true, lastSeenAt: true });
  });
});
