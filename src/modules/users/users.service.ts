import { encodeCursor } from "../../shared/pagination/cursor.js";
import {
  InvalidTokenError,
  UsernameAlreadyInUseError,
} from "../auth/domain/auth.errors.js";
import { UserUniqueConstraintError } from "../auth/persistence/auth.repository.js";
import type {
  SearchableUserRecord,
  UsersRepository,
} from "./users.repository.js";
import type {
  SearchUsersQuery,
  UpdateCurrentUserInput,
} from "./users.schema.js";
import {
  toPublicUserProfile,
  type UserProfileChangeNotifier,
} from "./user-profile-change.service.js";

export interface PublicSearchUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface SearchUsersResult {
  items: readonly PublicSearchUser[];
  nextCursor: string | null;
}

export interface CurrentUserProfile {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: "ACTIVE" | "DISABLED";
  createdAt: Date;
}

export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly profileChanges: UserProfileChangeNotifier,
  ) {}

  async searchUsers(
    currentUserId: string,
    input: SearchUsersQuery,
  ): Promise<SearchUsersResult> {
    const records = await this.usersRepository.searchUsers({
      currentUserId,
      query: input.query,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      take: input.limit + 1,
    });
    const hasNextPage = records.length > input.limit;
    const items = records.slice(0, input.limit);

    return {
      items: items.map(toPublicSearchUser),
      nextCursor: hasNextPage
        ? createNextCursor(items.at(-1))
        : null,
    };
  }

  async updateCurrentUser(
    currentUserId: string,
    input: UpdateCurrentUserInput,
  ): Promise<CurrentUserProfile> {
    try {
      const user = await this.usersRepository.updateCurrentUser(
        currentUserId,
        input,
      );

      if (
        user === null ||
        user.status !== "ACTIVE" ||
        user.deletedAt !== null
      ) {
        throw new InvalidTokenError();
      }

      const profile = {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        status: user.status,
        createdAt: user.createdAt,
      };

      await this.profileChanges.notifyProfileUpdated(
        toPublicUserProfile(profile),
      );

      return profile;
    } catch (error: unknown) {
      if (
        error instanceof UserUniqueConstraintError &&
        error.fields.includes("username")
      ) {
        throw new UsernameAlreadyInUseError();
      }

      throw error;
    }
  }
}

function toPublicSearchUser(user: SearchableUserRecord): PublicSearchUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

function createNextCursor(user: SearchableUserRecord | undefined): string {
  if (user === undefined) {
    throw new Error("Cannot create a cursor for an empty page");
  }

  return encodeCursor({ v: 1, username: user.username, id: user.id });
}
