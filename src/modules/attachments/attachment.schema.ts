import { z } from "zod";

import {
  attachmentKindForContentType,
  isAttachmentContentType,
  maximumAttachmentBytesForKind,
  MAX_PDF_ATTACHMENT_BYTES,
} from "./attachment.constants.js";

export const createAttachmentUploadSchema = z
  .object({
    contentType: z.string().trim().toLowerCase().min(1).max(128),
    contentLength: z.number().int().positive().max(MAX_PDF_ATTACHMENT_BYTES),
    originalFileName: z.string().trim().min(1),
  })
  .strict()
  .superRefine((input, context) => {
    if (!isAttachmentContentType(input.contentType)) {
      return;
    }

    const maximum = maximumAttachmentBytesForKind(
      attachmentKindForContentType(input.contentType),
    );

    if (input.contentLength > maximum) {
      context.addIssue({
        code: "too_big",
        maximum,
        origin: "number",
        inclusive: true,
        path: ["contentLength"],
        message: `Too big: expected number to be <= ${String(maximum)}`,
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
