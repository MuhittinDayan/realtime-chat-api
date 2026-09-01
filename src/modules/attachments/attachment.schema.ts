import { z } from "zod";

import {
  isAttachmentContentType,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
} from "./attachment.constants.js";

export const createAttachmentUploadSchema = z
  .object({
    contentType: z.string().trim().toLowerCase().min(1).max(64),
    contentLength: z.number().int().positive().max(MAX_PDF_ATTACHMENT_BYTES),
    originalFileName: z.string().trim().min(1),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      isAttachmentContentType(input.contentType) &&
      input.contentType !== "application/pdf" &&
      input.contentLength > MAX_IMAGE_ATTACHMENT_BYTES
    ) {
      context.addIssue({
        code: "too_big",
        maximum: MAX_IMAGE_ATTACHMENT_BYTES,
        origin: "number",
        inclusive: true,
        path: ["contentLength"],
        message: `Too big: expected number to be <= ${String(MAX_IMAGE_ATTACHMENT_BYTES)}`,
      });
    }
  });

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
