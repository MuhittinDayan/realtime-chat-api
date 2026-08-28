import { Router, type RequestHandler } from "express";

import {
  withValidatedBody,
  withValidatedParams,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import {
  avatarUploadRateLimit,
  userSearchRateLimit,
} from "../../http/middleware/rate-limit.js";
import {
  objectStorage,
  storageBuckets,
  storageSettings,
} from "../../infrastructure/storage/index.js";
import { authService } from "../auth/auth-core.js";
import { createAuthenticationMiddleware } from "../auth/auth.middleware.js";
import { AvatarController } from "../media/avatar.controller.js";
import { SharpAvatarImageProcessor } from "../media/avatar-image.processor.js";
import { PrismaAvatarRepository } from "../media/avatar.repository.js";
import {
  avatarUploadParamsSchema,
  createAvatarUploadSchema,
} from "../media/avatar.schema.js";
import { AvatarService } from "../media/avatar.service.js";
import { UsersController } from "./users.controller.js";
import { PrismaUsersRepository } from "./users.repository.js";
import {
  searchUsersQuerySchema,
  updateCurrentUserSchema,
} from "./users.schema.js";
import { UsersService } from "./users.service.js";

export interface CreateUsersRouterOptions {
  controller: UsersController;
  avatarController?: AvatarController;
  authenticationMiddleware: RequestHandler;
  searchRateLimitMiddleware?: RequestHandler;
  avatarRateLimitMiddleware?: RequestHandler;
}

export function createUsersRouter(
  options: CreateUsersRouterOptions,
): Router {
  const router = Router();

  router.use(options.authenticationMiddleware);
  if (options.avatarController !== undefined) {
    const rateLimit =
      options.avatarRateLimitMiddleware ?? avatarUploadRateLimit;

    router.post(
      "/me/avatar/uploads",
      rateLimit,
      withValidatedBody(
        createAvatarUploadSchema,
        options.avatarController.createUpload,
      ),
    );
    router.post(
      "/me/avatar/uploads/:uploadId/complete",
      rateLimit,
      withValidatedParams(
        avatarUploadParamsSchema,
        options.avatarController.completeUpload,
      ),
    );
    router.delete("/me/avatar", options.avatarController.deleteAvatar);
  }
  router.patch(
    "/me",
    withValidatedBody(updateCurrentUserSchema, options.controller.updateMe),
  );
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
const avatarRepository = new PrismaAvatarRepository();
const avatarService = new AvatarService(
  avatarRepository,
  objectStorage,
  new SharpAvatarImageProcessor(),
  {
    avatarBucket: storageBuckets.avatar,
    publicAvatarBaseUrl: storageSettings.publicAvatarBaseUrl,
    uploadUrlTtlSeconds: storageSettings.avatarUploadUrlTtlSeconds,
    cacheControl: storageSettings.avatarCacheControl,
  },
);
const avatarController = new AvatarController(avatarService);

export const usersRouter = createUsersRouter({
  controller: usersController,
  avatarController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
});
