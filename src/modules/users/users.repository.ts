import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { UserSearchCursor } from "./users.schema.js";

export interface SearchableUserRecord {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SearchUsersRepositoryInput {
  currentUserId: string;
  query: string;
  cursor?: UserSearchCursor;
  take: number;
}

export interface UsersRepository {
  searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<readonly SearchableUserRecord[]>;
}

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

export class PrismaUsersRepository implements UsersRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<readonly SearchableUserRecord[]> {
    const cursorFilter =
      input.cursor === undefined
        ? undefined
        : {
            OR: [
              { username: { gt: input.cursor.username } },
              {
                username: input.cursor.username,
                id: { gt: input.cursor.id },
              },
            ],
          };

    return this.client.user.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        id: { not: input.currentUserId },
        AND: [
          {
            OR: [
              {
                username: {
                  contains: input.query,
                  mode: "insensitive",
                },
              },
              {
                displayName: {
                  contains: input.query,
                  mode: "insensitive",
                },
              },
            ],
          },
          ...(cursorFilter === undefined ? [] : [cursorFilter]),
        ],
      },
      orderBy: [{ username: "asc" }, { id: "asc" }],
      take: input.take,
      select: publicUserSelect,
    });
  }
}
