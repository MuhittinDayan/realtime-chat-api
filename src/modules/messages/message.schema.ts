import { z } from "zod";

import { decodeCursor } from "../../shared/pagination/cursor.js";

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

export const createMessageBodySchema = z
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

export const messageHistoryQuerySchema = z
  .object({
    before: historyCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateMessageBody = z.infer<typeof createMessageBodySchema>;
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;
