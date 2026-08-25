import { z } from "zod";

export const updateReadWatermarkBodySchema = z
  .object({ throughMessageId: z.string().uuid() })
  .strict();

export type UpdateReadWatermarkBody = z.infer<
  typeof updateReadWatermarkBodySchema
>;
