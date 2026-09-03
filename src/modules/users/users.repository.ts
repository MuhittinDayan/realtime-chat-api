import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import {
  toUserUniqueConstraintError,
  type UserRecord,
} from "../auth/persistence/auth.repository.js";
import type {
  UpdateCurrentUserInput,
  UserSearchCursor,
} from "./users.schema.js";
import type { UserProfileAudienceRepository } from "./user-profile-change.service.js";

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

export interface UsersRepository extends UserProfileAudienceRepository {
  searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<readonly SearchableUserRecord[]>;
  updateCurrentUser(
    userId: string,
    input: UpdateCurrentUserInput,
  ): Promise<UserRecord | null>;
}

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

const currentUserSelect = {
  id: true,
  email: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  status: true,
  createdAt: true,
  deletedAt: true,
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

  async findProfileAudienceUserIds(
    userId: string,
  ): Promise<readonly string[]> {
    const users = await this.client.user.findMany({
      where: {
        id: { not: userId },
        status: "ACTIVE",
        deletedAt: null,
        conversationMembers: {
          some: {
            leftAt: null,
            conversation: {
              members: { some: { userId, leftAt: null } },
            },
          },
        },
      },
      select: { id: true },
    });

    return users.map((user) => user.id);
  }

  async updateCurrentUser(
    userId: string,
    input: UpdateCurrentUserInput,
  ): Promise<UserRecord | null> {
    try {
      return await this.client.user.update({
        where: { id: userId },
        data: {
          ...(input.username === undefined
            ? {}
            : { username: input.username }),
          ...(input.displayName === undefined
            ? {}
            : { displayName: input.displayName }),
        },
        select: currentUserSelect,
      });
    } catch (error: unknown) {
      const uniqueError = toUserUniqueConstraintError(error);

      if (uniqueError !== null) {
        throw uniqueError;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        return null;
      }

      throw error;
    }
  }
}
