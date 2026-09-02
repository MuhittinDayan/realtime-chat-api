import { describe, expect, it } from "vitest";

import type {
  SearchableUserRecord,
  SearchUsersRepositoryInput,
  UsersRepository,
} from "./users.repository.js";
import type { UserRecord } from "../auth/persistence/auth.repository.js";
import { UserUniqueConstraintError } from "../auth/persistence/auth.repository.js";
import { UsernameAlreadyInUseError } from "../auth/domain/auth.errors.js";
import {
  searchUsersQuerySchema,
  type UpdateCurrentUserInput,
} from "./users.schema.js";
import { UsersService } from "./users.service.js";

const CURRENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CAROL_ID = "33333333-3333-4333-8333-333333333333";

class FakeUsersRepository implements UsersRepository {
  input: SearchUsersRepositoryInput | null = null;
  updateInput: { userId: string; input: UpdateCurrentUserInput } | null = null;
  updatedUser: UserRecord | null = null;
  updateError: unknown = null;

  constructor(readonly records: readonly SearchableUserRecord[]) {}

  async searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<readonly SearchableUserRecord[]> {
    this.input = input;
    return this.records;
  }

  async updateCurrentUser(
    userId: string,
    input: UpdateCurrentUserInput,
  ): Promise<UserRecord | null> {
    this.updateInput = { userId, input };
    if (this.updateError !== null) {
      throw this.updateError;
    }
    return this.updatedUser;
  }
}

describe("users service", () => {
  it("returns only public fields and requests one extra pagination row", async () => {
    const repository = new FakeUsersRepository([
      {
        id: BOB_ID,
        username: "bob",
        displayName: "Bob",
        avatarUrl: null,
      },
    ]);
    const service = new UsersService(repository);

    const result = await service.searchUsers(CURRENT_USER_ID, {
      query: "bo",
      limit: 20,
    });

    expect(repository.input).toEqual({
      currentUserId: CURRENT_USER_ID,
      query: "bo",
      take: 21,
    });
    expect(result.items).toEqual(repository.records);
    expect(result.items[0]).not.toHaveProperty("email");
    expect(result.nextCursor).toBeNull();
  });

  it("creates a cursor from the final returned row", async () => {
    const repository = new FakeUsersRepository([
      {
        id: BOB_ID,
        username: "bob",
        displayName: "Bob",
        avatarUrl: null,
      },
      {
        id: CAROL_ID,
        username: "carol",
        displayName: "Carol",
        avatarUrl: null,
      },
    ]);
    const service = new UsersService(repository);

    const firstPage = await service.searchUsers(CURRENT_USER_ID, {
      query: "ar",
      limit: 1,
    });
    const parsedNextPage = searchUsersQuerySchema.parse({
      query: "ar",
      cursor: firstPage.nextCursor,
    });

    expect(firstPage.items.map((user) => user.id)).toEqual([BOB_ID]);
    expect(parsedNextPage.cursor).toEqual({ username: "bob", id: BOB_ID });
  });

  it("updates the current user's public profile", async () => {
    const repository = new FakeUsersRepository([]);
    repository.updatedUser = {
      id: CURRENT_USER_ID,
      email: "alice@example.com",
      username: "new-alice",
      displayName: "New Alice",
      avatarUrl: null,
      status: "ACTIVE",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      deletedAt: null,
    };
    const service = new UsersService(repository);

    const result = await service.updateCurrentUser(CURRENT_USER_ID, {
      username: "new-alice",
      displayName: "New Alice",
    });

    expect(result).not.toHaveProperty("deletedAt");
    expect(result.username).toBe("new-alice");
  });

  it("maps a username unique-constraint race to conflict", async () => {
    const repository = new FakeUsersRepository([]);
    repository.updateError = new UserUniqueConstraintError(
      ["username"],
      new Error("simulated database conflict"),
    );
    const service = new UsersService(repository);

    await expect(
      service.updateCurrentUser(CURRENT_USER_ID, { username: "bob" }),
    ).rejects.toBeInstanceOf(UsernameAlreadyInUseError);
  });
});
