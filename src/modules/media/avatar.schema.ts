import { z } from "zod";

import { MAX_AVATAR_BYTES } from "./avatar.constants.js";

export const createAvatarUploadSchema = z
  .object({
    contentType: z.string().trim().min(1).max(64),
    contentLength: z.number().int().positive().max(MAX_AVATAR_BYTES),
  })
  .strict();

export const avatarUploadParamsSchema = z
  .object({ uploadId: z.string().uuid() })
  .strict();

export type CreateAvatarUploadInput = z.infer<
  typeof createAvatarUploadSchema
>;
export type AvatarUploadParams = z.infer<typeof avatarUploadParamsSchema>;
