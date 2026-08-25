import { Router } from "express";

import {
  validateParams,
  withValidatedBody,
} from "../../http/validation/request-validation.js";
import { conversationParamsSchema } from "../conversations/conversation.schema.js";
import { readController } from "./read-core.js";
import type { ReadController } from "./read.controller.js";
import { updateReadWatermarkBodySchema } from "./read.schema.js";

export function createReadRouter(controller: ReadController): Router {
  const router = Router({ mergeParams: true });

  router.use(validateParams(conversationParamsSchema));
  router.put(
    "/",
    withValidatedBody(updateReadWatermarkBodySchema, controller.update),
  );

  return router;
}

export const readRouter = createReadRouter(readController);
