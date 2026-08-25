import { z } from "zod";

import { decodeCursor } from "../../shared/pagination/cursor.js";

export interface ConversationListCursor {
  lastMessageAt: Date | null;
  createdAt: Date;
  id: string;
}

const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    lastMessageAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const conversationCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(768)
  .transform((value, context): ConversationListCursor => {
    try {
      const result = cursorPayloadSchema.safeParse(decodeCursor(value));

      if (result.success) {
        return {
          lastMessageAt:
            result.data.lastMessageAt === null
              ? null
              : new Date(result.data.lastMessageAt),
          createdAt: new Date(result.data.createdAt),
          id: result.data.id,
        };
      }
    } catch {
      // Report every malformed or unsupported cursor uniformly.
    }

    context.addIssue({ code: "custom", message: "Invalid cursor" });

    return z.NEVER;
  });

export const createDirectConversationBodySchema = z
  .object({ userId: z.string().uuid() })
  .strict();

export const listConversationsQuerySchema = z
  .object({
    cursor: conversationCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const conversationParamsSchema = z
  .object({ conversationId: z.string().uuid() })
  .strict();

export type CreateDirectConversationBody = z.infer<
  typeof createDirectConversationBodySchema
>;
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;
export type ConversationParams = z.infer<typeof conversationParamsSchema>;
