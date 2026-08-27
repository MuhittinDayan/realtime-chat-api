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

const titleSchema = z.string().trim().min(1).max(120);

export const createGroupConversationBodySchema = z
  .object({
    title: titleSchema,
    userIds: z.array(z.string().uuid()).min(2).max(99),
  })
  .strict()
  .refine((value) => new Set(value.userIds).size === value.userIds.length, {
    path: ["userIds"],
    message: "User ids must be unique",
  });

export const updateGroupTitleBodySchema = z
  .object({ title: titleSchema })
  .strict();

export const addGroupMemberBodySchema = z
  .object({ userId: z.string().uuid() })
  .strict();

export const updateGroupMemberRoleBodySchema = z
  .object({ role: z.enum(["MEMBER", "ADMIN"]) })
  .strict();

export const transferGroupOwnershipBodySchema = z
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

export const groupMemberParamsSchema = conversationParamsSchema.extend({
  userId: z.string().uuid(),
});

export type CreateDirectConversationBody = z.infer<
  typeof createDirectConversationBodySchema
>;
export type CreateGroupConversationBody = z.infer<
  typeof createGroupConversationBodySchema
>;
export type UpdateGroupTitleBody = z.infer<
  typeof updateGroupTitleBodySchema
>;
export type GroupMemberParams = z.infer<typeof groupMemberParamsSchema>;
export type AddGroupMemberBody = z.infer<typeof addGroupMemberBodySchema>;
export type UpdateGroupMemberRoleBody = z.infer<
  typeof updateGroupMemberRoleBodySchema
>;
export type TransferGroupOwnershipBody = z.infer<
  typeof transferGroupOwnershipBodySchema
>;
export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;
export type ConversationParams = z.infer<typeof conversationParamsSchema>;
