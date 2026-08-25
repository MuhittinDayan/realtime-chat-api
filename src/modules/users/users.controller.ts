import { requireAuthContext } from "../auth/auth.middleware.js";
import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import type { SearchUsersQuery } from "./users.schema.js";
import type { SearchUsersResult } from "./users.service.js";

export interface UsersHttpService {
  searchUsers(
    currentUserId: string,
    input: SearchUsersQuery,
  ): Promise<SearchUsersResult>;
}

export class UsersController {
  constructor(private readonly usersService: UsersHttpService) {}

  readonly search: ValidatedRequestHandler<SearchUsersQuery> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const result = await this.usersService.searchUsers(auth.userId, input);

    response.status(200).json(result);
  };
}
