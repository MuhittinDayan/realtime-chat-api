export const ATTACHMENT_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ATTACHMENT_PDF_CONTENT_TYPE = "application/pdf" as const;

export const ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  ...ATTACHMENT_IMAGE_CONTENT_TYPES,
  ATTACHMENT_PDF_CONTENT_TYPE,
] as const;

export type AttachmentContentType =
  (typeof ATTACHMENT_ALLOWED_CONTENT_TYPES)[number];

export function isAttachmentContentType(
  value: unknown,
): value is AttachmentContentType {
  return (
    typeof value === "string" &&
    (ATTACHMENT_ALLOWED_CONTENT_TYPES as readonly string[]).includes(value)
  );
}

export type AttachmentKind = "IMAGE" | "PDF";

export function attachmentKindForContentType(
  contentType: AttachmentContentType,
): AttachmentKind {
  return contentType === ATTACHMENT_PDF_CONTENT_TYPE ? "PDF" : "IMAGE";
}

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1_024 * 1_024;
export const MAX_PDF_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
export const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES = 50 * 1_024 * 1_024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_DIMENSION = 8_192;
export const MAX_ATTACHMENT_OUTPUT_DIMENSION = 4_096;
export const ATTACHMENT_THUMBNAIL_DIMENSION = 480;
