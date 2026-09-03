import { Router, type RequestHandler } from "express";

import {
  withValidatedParams,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import { authService } from "../auth/auth-core.js";
import { createAuthenticationMiddleware } from "../auth/http/auth.middleware.js";
import { conversationParamsSchema } from "../conversations/conversation.schema.js";
import type { NotificationController } from "./notification.controller.js";
import { notificationController } from "./notification-core.js";
import {
  listNotificationsQuerySchema,
  notificationParamsSchema,
} from "./notification.schema.js";

export function createNotificationRouter(options: {
  controller: NotificationController;
  authenticationMiddleware: RequestHandler;
}): Router {
  const router = Router();
  router.use(options.authenticationMiddleware);
  router.get(
    "/",
    withValidatedQuery(listNotificationsQuerySchema, options.controller.list),
  );
  router.get("/unread-count", options.controller.unreadCount);
  router.patch(
    "/:notificationId/read",
    withValidatedParams(notificationParamsSchema, options.controller.markRead),
  );
  return router;
}

export function createConversationNotificationRouter(
  controller: NotificationController,
): Router {
  const router = Router({ mergeParams: true });
  router.patch(
    "/read",
    withValidatedParams(
      conversationParamsSchema,
      controller.markConversationRead,
    ),
  );
  return router;
}

export const notificationRouter = createNotificationRouter({
  controller: notificationController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
});

export const conversationNotificationRouter =
  createConversationNotificationRouter(notificationController);
