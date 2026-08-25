import { Router, type RequestHandler } from "express";

import {
  withValidatedBody,
  withValidatedParams,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import { authService } from "../auth/auth-core.js";
import { createAuthenticationMiddleware } from "../auth/auth.middleware.js";
import { messageRouter } from "../messages/message.routes.js";
import { readRouter } from "../reads/read.routes.js";
import { conversationController } from "./conversation-core.js";
import type { ConversationController } from "./conversation.controller.js";
import {
  conversationParamsSchema,
  createDirectConversationBodySchema,
  listConversationsQuerySchema,
} from "./conversation.schema.js";

export interface CreateConversationRouterOptions {
  controller: ConversationController;
  authenticationMiddleware: RequestHandler;
}

export function createConversationRouter(
  options: CreateConversationRouterOptions,
): Router {
  const router = Router();

  router.use(options.authenticationMiddleware);
  router.post(
    "/direct",
    withValidatedBody(
      createDirectConversationBodySchema,
      options.controller.createDirect,
    ),
  );
  router.use("/:conversationId/messages", messageRouter);
  router.use("/:conversationId/read", readRouter);
  router.get(
    "/",
    withValidatedQuery(
      listConversationsQuerySchema,
      options.controller.list,
    ),
  );
  router.get(
    "/:conversationId",
    withValidatedParams(conversationParamsSchema, options.controller.get),
  );

  return router;
}

export const conversationRouter = createConversationRouter({
  controller: conversationController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
});
