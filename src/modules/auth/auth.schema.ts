import { z } from "zod";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const emailSchema = z
  .string()
  .trim()
  .max(320)
  .email()
  .transform(normalizeEmail);

const usernameSchema = z.string().trim().min(1).max(32);
const displayNameSchema = z.string().trim().min(1).max(80);

export const registerSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    displayName: displayNameSchema,
    password: z.string().min(12).max(128),
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
