import { z } from "zod";

import { decodeCursor } from "../../shared/pagination/cursor.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../attachments/attachment.constants.js";

export interface MessageHistoryCursor {
  createdAt: Date;
  id: string;
}

const historyCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const historyCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .transform((value, context): MessageHistoryCursor => {
    try {
      const result = historyCursorPayloadSchema.safeParse(
        decodeCursor(value),
      );

      if (result.success) {
        return {
          createdAt: new Date(result.data.createdAt),
          id: result.data.id,
        };
      }
    } catch {
      // Report malformed and unsupported cursors uniformly.
    }

    context.addIssue({ code: "custom", message: "Invalid cursor" });
    return z.NEVER;
  });

const createTextMessageBodySchema = z
  .object({
    clientMessageId: z.string().uuid(),
    content: z
      .object({
        type: z.literal("text"),
        text: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();

const createMediaMessageBodySchema = z
  .object({
    clientMessageId: z.string().uuid(),
    content: z
      .object({
        type: z.literal("media"),
        text: z.string().trim().min(1).max(4_000).optional(),
        attachmentIds: z
          .array(z.string().uuid())
          .min(1)
          .max(MAX_ATTACHMENTS_PER_MESSAGE)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: "Attachment ids must be unique",
          }),
      })
      .strict(),
  })
  .strict();

export const createMessageBodySchema = z.union([
  createTextMessageBodySchema,
  createMediaMessageBodySchema,
]);

const updateTextMessageBodySchema = z
  .object({
    content: z
      .object({
        type: z.literal("text"),
        text: z.string().trim().min(1).max(4_000),
      })
      .strict(),
  })
  .strict();

const updateMediaMessageBodySchema = z
  .object({
    content: z
      .object({
        type: z.literal("media"),
        text: z.string().trim().min(1).max(4_000).nullable(),
      })
      .strict(),
  })
  .strict();

export const updateMessageBodySchema = z.union([
  updateTextMessageBodySchema,
  updateMediaMessageBodySchema,
]);

export const messageParamsSchema = z
  .object({
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
  })
  .strict();

export const messageHistoryQuerySchema = z
  .object({
    before: historyCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateMessageBody = z.infer<typeof createMessageBodySchema>;
export type UpdateMessageBody = z.infer<typeof updateMessageBodySchema>;
export type MessageParams = z.infer<typeof messageParamsSchema>;
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;
