import { Router, type RequestHandler } from "express";

import { messageCreateRateLimit } from "../../http/middleware/rate-limit.js";
import {
  validateParams,
  withValidatedBody,
  withValidatedParams,
} from "../../http/validation/request-validation.js";
import { conversationParamsSchema } from "../conversations/conversation.schema.js";
import { attachmentController } from "./attachment-core.js";
import type { AttachmentController } from "./attachment.controller.js";
import {
  attachmentAccessParamsSchema,
  attachmentUploadParamsSchema,
  createAttachmentUploadSchema,
} from "./attachment.schema.js";

export function createAttachmentRouter(
  controller: AttachmentController,
  uploadRateLimitMiddleware: RequestHandler = messageCreateRateLimit,
): Router {
  const router = Router({ mergeParams: true });

  router.use(validateParams(conversationParamsSchema));
  router.post(
    "/uploads",
    uploadRateLimitMiddleware,
    withValidatedBody(createAttachmentUploadSchema, controller.createUpload),
  );
  router.post(
    "/uploads/:attachmentId/complete",
    uploadRateLimitMiddleware,
    withValidatedParams(
      attachmentUploadParamsSchema,
      controller.completeUpload,
    ),
  );
  router.get(
    "/:attachmentId/:variant",
    withValidatedParams(attachmentAccessParamsSchema, controller.access),
  );

  return router;
}

export const attachmentRouter = createAttachmentRouter(attachmentController);
