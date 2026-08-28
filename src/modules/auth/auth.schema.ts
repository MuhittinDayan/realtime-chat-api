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

export const usernameSchema = z.string().trim().min(1).max(32);
export const displayNameSchema = z.string().trim().min(1).max(80);
export const passwordSchema = z.string().min(12).max(128);
const currentPasswordSchema = z.string().min(1).max(128);

export const registerSchema = z
  .object({
    email: emailSchema,
    username: usernameSchema,
    displayName: displayNameSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: currentPasswordSchema,
  })
  .strict();

export const changePasswordSchema = z
  .object({
    currentPassword: currentPasswordSchema,
    newPassword: passwordSchema,
  })
  .strict();

export const authSessionParamsSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type AuthSessionParams = z.infer<typeof authSessionParamsSchema>;
