import { z } from "zod";

import { decodeCursor } from "../../shared/pagination/cursor.js";

export interface NotificationListCursor {
  createdAt: Date;
  id: string;
}

const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

const notificationCursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(768)
  .transform((value, context): NotificationListCursor => {
    try {
      const result = cursorPayloadSchema.safeParse(decodeCursor(value));

      if (result.success) {
        return {
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

export const listNotificationsQuerySchema = z
  .object({
    cursor: notificationCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();

export const notificationParamsSchema = z
  .object({ notificationId: z.string().uuid() })
  .strict();

export type ListNotificationsQuery = z.infer<
  typeof listNotificationsQuerySchema
>;
export type NotificationParams = z.infer<typeof notificationParamsSchema>;
