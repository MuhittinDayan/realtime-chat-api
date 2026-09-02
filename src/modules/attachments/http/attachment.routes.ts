import { Router, type RequestHandler } from "express";

import { messageCreateRateLimit } from "../../../http/middleware/rate-limit.ts";
import {
  validateParams,
  withValidatedBody,
  withValidatedParams,
} from "../../../http/validation/request-validation.ts";
import { conversationParamsSchema } from "../../conversations/conversation.schema.ts";
import { attachmentController } from "../attachment-core.ts";
import type { AttachmentController } from "./attachment.controller.ts";
import {
  attachmentAccessParamsSchema,
  attachmentUploadParamsSchema,
  createAttachmentUploadSchema,
} from "./attachment.schema.ts";

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
