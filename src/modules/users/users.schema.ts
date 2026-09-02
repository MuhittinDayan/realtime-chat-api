import { z } from "zod";

import { decodeCursor } from "../../shared/pagination/cursor.js";
import {
  displayNameSchema,
  usernameSchema,
} from "../auth/http/auth.schema.js";

export interface UserSearchCursor {
  username: string;
  id: string;
}

const userSearchCursorPayloadSchema = z
  .object({
    v: z.literal(1),
    username: z.string().min(1).max(32),
    id: z.string().uuid(),
  })
  .strict();

const userSearchCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .transform((value, context): UserSearchCursor => {
    try {
      const result = userSearchCursorPayloadSchema.safeParse(
        decodeCursor(value),
      );

      if (result.success) {
        return {
          username: result.data.username,
          id: result.data.id,
        };
      }
    } catch {
      // Report every malformed or unsupported cursor uniformly.
    }

    context.addIssue({
      code: "custom",
      message: "Invalid cursor",
    });

    return z.NEVER;
  });

export const searchUsersQuerySchema = z
  .object({
    query: z.string().trim().min(2).max(80),
    cursor: userSearchCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const updateCurrentUserSchema = z
  .object({
    username: usernameSchema.optional(),
    displayName: displayNameSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.username !== undefined || input.displayName !== undefined,
    { message: "At least one profile field is required" },
  );

export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
export type UpdateCurrentUserInput = z.infer<typeof updateCurrentUserSchema>;
