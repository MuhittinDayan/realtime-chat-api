import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaUsersRepository } from "./users.repository.js";

const CURRENT_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("Prisma users repository", () => {
  it("filters active non-deleted users, excludes self and never searches email", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { user: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaUsersRepository(client);

    await repository.searchUsers({
      currentUserId: CURRENT_USER_ID,
      query: "ali",
      take: 21,
    });

    const query = findMany.mock.calls[0]?.[0];
    expect(query.where.status).toBe("ACTIVE");
    expect(query.where.deletedAt).toBeNull();
    expect(query.where.id).toEqual({ not: CURRENT_USER_ID });
    expect(JSON.stringify(query.where)).not.toContain("email");
    expect(query.orderBy).toEqual([
      { username: "asc" },
      { id: "asc" },
    ]);
    expect(query.take).toBe(21);
  });

  it("applies a strict keyset predicate after the cursor", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const client = { user: { findMany } } as unknown as PrismaClient;
    const repository = new PrismaUsersRepository(client);

    await repository.searchUsers({
      currentUserId: CURRENT_USER_ID,
      query: "bo",
      cursor: {
        username: "bob",
        id: "22222222-2222-4222-8222-222222222222",
      },
      take: 20,
    });

    expect(findMany.mock.calls[0]?.[0].where.AND[1]).toEqual({
      OR: [
        { username: { gt: "bob" } },
        {
          username: "bob",
          id: { gt: "22222222-2222-4222-8222-222222222222" },
        },
      ],
    });
  });
});
