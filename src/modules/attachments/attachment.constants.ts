export const ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AttachmentContentType =
  (typeof ATTACHMENT_ALLOWED_CONTENT_TYPES)[number];

export function isAttachmentContentType(
  value: string,
): value is AttachmentContentType {
  return (ATTACHMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes(
    value,
  );
}

export const MAX_ATTACHMENT_BYTES = 10 * 1_024 * 1_024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_DIMENSION = 8_192;
export const MAX_ATTACHMENT_OUTPUT_DIMENSION = 4_096;
export const ATTACHMENT_THUMBNAIL_DIMENSION = 480;
