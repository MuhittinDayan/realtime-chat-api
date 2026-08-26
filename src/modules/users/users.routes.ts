import { Router, type RequestHandler } from "express";

import { withValidatedQuery } from "../../http/validation/request-validation.js";
import { userSearchRateLimit } from "../../http/middleware/rate-limit.js";
import { authService } from "../auth/auth-core.js";
import { createAuthenticationMiddleware } from "../auth/auth.middleware.js";
import { UsersController } from "./users.controller.js";
import { PrismaUsersRepository } from "./users.repository.js";
import { searchUsersQuerySchema } from "./users.schema.js";
import { UsersService } from "./users.service.js";

export interface CreateUsersRouterOptions {
  controller: UsersController;
  authenticationMiddleware: RequestHandler;
  searchRateLimitMiddleware?: RequestHandler;
}

export function createUsersRouter(
  options: CreateUsersRouterOptions,
): Router {
  const router = Router();

  router.use(options.authenticationMiddleware);
  router.get(
    "/",
    options.searchRateLimitMiddleware ?? userSearchRateLimit,
    withValidatedQuery(searchUsersQuerySchema, options.controller.search),
  );

  return router;
}

const usersRepository = new PrismaUsersRepository();
const usersService = new UsersService(usersRepository);
const usersController = new UsersController(usersService);

export const usersRouter = createUsersRouter({
  controller: usersController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
});
