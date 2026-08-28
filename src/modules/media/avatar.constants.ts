export const AVATAR_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AvatarContentType =
  (typeof AVATAR_ALLOWED_CONTENT_TYPES)[number];

export function isAvatarContentType(value: string): value is AvatarContentType {
  return (AVATAR_ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

export const MAX_AVATAR_BYTES = 5 * 1_024 * 1_024;
export const MAX_AVATAR_DIMENSION = 4_096;
export const AVATAR_OUTPUT_DIMENSION = 512;
