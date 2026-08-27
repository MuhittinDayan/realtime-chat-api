import { Router, type RequestHandler } from "express";

import { messageCreateRateLimit } from "../../http/middleware/rate-limit.js";
import {
  validateParams,
  withValidatedBody,
  withValidatedParams,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import { conversationParamsSchema } from "../conversations/conversation.schema.js";
import { messageController } from "./message-core.js";
import type { MessageController } from "./message.controller.js";
import {
  createMessageBodySchema,
  messageParamsSchema,
  messageHistoryQuerySchema,
  updateMessageBodySchema,
} from "./message.schema.js";

export function createMessageRouter(
  controller: MessageController,
  createRateLimitMiddleware: RequestHandler = messageCreateRateLimit,
): Router {
  const router = Router({ mergeParams: true });

  router.use(validateParams(conversationParamsSchema));
  router.post(
    "/",
    createRateLimitMiddleware,
    withValidatedBody(createMessageBodySchema, controller.create),
  );
  router.get(
    "/",
    withValidatedQuery(messageHistoryQuerySchema, controller.list),
  );
  router.patch(
    "/:messageId",
    validateParams(messageParamsSchema),
    withValidatedBody(updateMessageBodySchema, controller.update),
  );
  router.delete(
    "/:messageId",
    withValidatedParams(messageParamsSchema, controller.delete),
  );

  return router;
}

export const messageRouter = createMessageRouter(messageController);
