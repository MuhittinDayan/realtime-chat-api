import { Router, type RequestHandler } from "express";

import { env } from "../../config/env.js";
import { systemClock } from "../../shared/time/clock.js";
import { authService } from "./auth-core.js";
import { AuthController } from "./auth.controller.js";
import {
  createAuthenticationMiddleware,
  createTrustedOriginMiddleware,
} from "./auth.middleware.js";
import { loginSchema, registerSchema } from "./auth.schema.js";
import { withValidatedBody } from "./auth.validation.js";
import { HttpRefreshCookieManager } from "./refresh-cookie.js";

export interface CreateAuthRouterOptions {
  controller: AuthController;
  authenticationMiddleware: RequestHandler;
  trustedOriginMiddleware: RequestHandler;
}

export function createAuthRouter(options: CreateAuthRouterOptions): Router {
  const router = Router();

  router.post(
    "/register",
    withValidatedBody(registerSchema, options.controller.register),
  );
  router.post(
    "/login",
    withValidatedBody(loginSchema, options.controller.login),
  );
  router.post(
    "/refresh",
    options.trustedOriginMiddleware,
    options.controller.refresh,
  );
  router.post(
    "/logout",
    options.trustedOriginMiddleware,
    options.authenticationMiddleware,
    options.controller.logout,
  );
  router.get(
    "/me",
    options.authenticationMiddleware,
    options.controller.me,
  );

  return router;
}

const refreshCookieManager = new HttpRefreshCookieManager({
  secure: env.NODE_ENV === "production",
  clock: systemClock,
});

const authController = new AuthController({
  authService,
  refreshCookieManager,
});

export const authRouter = createAuthRouter({
  controller: authController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
  trustedOriginMiddleware: createTrustedOriginMiddleware({
    trustedOrigin: env.FRONTEND_ORIGIN,
    enforce: env.NODE_ENV === "production",
  }),
});
