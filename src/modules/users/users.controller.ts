import { requireAuthContext } from "../auth/http/auth.middleware.js";
import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import type {
  SearchUsersQuery,
  UpdateCurrentUserInput,
} from "./users.schema.js";
import type {
  CurrentUserProfile,
  SearchUsersResult,
} from "./users.service.js";

export interface UsersHttpService {
  searchUsers(
    currentUserId: string,
    input: SearchUsersQuery,
  ): Promise<SearchUsersResult>;
  updateCurrentUser(
    currentUserId: string,
    input: UpdateCurrentUserInput,
  ): Promise<CurrentUserProfile>;
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

  readonly updateMe: ValidatedRequestHandler<UpdateCurrentUserInput> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const user = await this.usersService.updateCurrentUser(auth.userId, input);

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ user });
  };
}
