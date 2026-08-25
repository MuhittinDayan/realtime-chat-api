import { Router } from "express";

import {
  validateParams,
  withValidatedBody,
  withValidatedQuery,
} from "../../http/validation/request-validation.js";
import { conversationParamsSchema } from "../conversations/conversation.schema.js";
import { messageController } from "./message-core.js";
import type { MessageController } from "./message.controller.js";
import {
  createMessageBodySchema,
  messageHistoryQuerySchema,
} from "./message.schema.js";

export function createMessageRouter(controller: MessageController): Router {
  const router = Router({ mergeParams: true });

  router.use(validateParams(conversationParamsSchema));
  router.post(
    "/",
    withValidatedBody(createMessageBodySchema, controller.create),
  );
  router.get(
    "/",
    withValidatedQuery(messageHistoryQuerySchema, controller.list),
  );

  return router;
}

export const messageRouter = createMessageRouter(messageController);
