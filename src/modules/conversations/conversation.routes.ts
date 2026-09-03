import { Router, type RequestHandler } from "express";

import {
  validateParams,
  withValidatedBody,
  withValidatedParams,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import { authService } from "../auth/auth-core.js";
import { createAuthenticationMiddleware } from "../auth/http/auth.middleware.js";
import { attachmentRouter } from "../attachments/http/attachment.routes.ts";
import { messageRouter } from "../messages/message.routes.js";
import { readRouter } from "../reads/read.routes.js";
import { conversationNotificationRouter } from "../notifications/notification.routes.js";
import { conversationController } from "./conversation-core.js";
import type { ConversationController } from "./conversation.controller.js";
import {
  addGroupMemberBodySchema,
  conversationParamsSchema,
  createDirectConversationBodySchema,
  createGroupConversationBodySchema,
  groupMemberParamsSchema,
  listConversationsQuerySchema,
  transferGroupOwnershipBodySchema,
  updateGroupMemberRoleBodySchema,
  updateConversationMuteBodySchema,
  updateGroupTitleBodySchema,
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
  router.post(
    "/group",
    withValidatedBody(
      createGroupConversationBodySchema,
      options.controller.createGroup,
    ),
  );
  router.use("/:conversationId/messages", messageRouter);
  router.use("/:conversationId/attachments", attachmentRouter);
  router.use("/:conversationId/read", readRouter);
  router.use("/:conversationId/notifications", conversationNotificationRouter);
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
  router.patch(
    "/:conversationId/mute",
    validateParams(conversationParamsSchema),
    withValidatedBody(
      updateConversationMuteBodySchema,
      options.controller.updateMute,
    ),
  );
  router.patch(
    "/:conversationId",
    validateParams(conversationParamsSchema),
    withValidatedBody(
      updateGroupTitleBodySchema,
      options.controller.updateTitle,
    ),
  );
  router.post(
    "/:conversationId/members",
    validateParams(conversationParamsSchema),
    withValidatedBody(addGroupMemberBodySchema, options.controller.addMember),
  );
  router.delete(
    "/:conversationId/members/me",
    withValidatedParams(conversationParamsSchema, options.controller.leave),
  );
  router.delete(
    "/:conversationId/members/:userId",
    withValidatedParams(groupMemberParamsSchema, options.controller.removeMember),
  );
  router.patch(
    "/:conversationId/members/:userId",
    validateParams(groupMemberParamsSchema),
    withValidatedBody(
      updateGroupMemberRoleBodySchema,
      options.controller.updateMemberRole,
    ),
  );
  router.put(
    "/:conversationId/owner",
    validateParams(conversationParamsSchema),
    withValidatedBody(
      transferGroupOwnershipBodySchema,
      options.controller.transferOwnership,
    ),
  );

  return router;
}

export const conversationRouter = createConversationRouter({
  controller: conversationController,
  authenticationMiddleware: createAuthenticationMiddleware(authService),
});
