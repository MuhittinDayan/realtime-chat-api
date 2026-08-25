import { encodeCursor } from "../../shared/pagination/cursor.js";
import type {
  SearchableUserRecord,
  UsersRepository,
} from "./users.repository.js";
import type { SearchUsersQuery } from "./users.schema.js";

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

export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

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
