import { z } from "zod";

import { MAX_ATTACHMENT_BYTES } from "./attachment.constants.js";

export const createAttachmentUploadSchema = z
  .object({
    contentType: z.string().trim().toLowerCase().min(1).max(64),
    contentLength: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
    originalFileName: z.string().trim().min(1),
  })
  .strict();

export const attachmentUploadParamsSchema = z
  .object({
    conversationId: z.string().uuid(),
    attachmentId: z.string().uuid(),
  })
  .strict();

export const attachmentAccessParamsSchema = z
  .object({
    conversationId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    variant: z.enum(["original", "thumbnail"]),
  })
  .strict();

export type CreateAttachmentUploadInput = z.infer<
  typeof createAttachmentUploadSchema
>;
export type AttachmentUploadParams = z.infer<
  typeof attachmentUploadParamsSchema
>;
export type AttachmentAccessParams = z.infer<
  typeof attachmentAccessParamsSchema
>;
