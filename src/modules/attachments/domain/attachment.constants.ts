export const ATTACHMENT_IMAGE_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const ATTACHMENT_PDF_CONTENT_TYPE = "application/pdf" as const;

export const ATTACHMENT_DOCX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;
export const ATTACHMENT_XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
export const ATTACHMENT_PPTX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation" as const;

export const ATTACHMENT_OFFICE_CONTENT_TYPES = [
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
] as const;

export const ATTACHMENT_ALLOWED_CONTENT_TYPES = [
  ...ATTACHMENT_IMAGE_CONTENT_TYPES,
  ATTACHMENT_PDF_CONTENT_TYPE,
  ...ATTACHMENT_OFFICE_CONTENT_TYPES,
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

export type AttachmentKind = "IMAGE" | "PDF" | "DOCX" | "XLSX" | "PPTX";

const ATTACHMENT_KIND_BY_CONTENT_TYPE = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  [ATTACHMENT_PDF_CONTENT_TYPE]: "PDF",
  [ATTACHMENT_DOCX_CONTENT_TYPE]: "DOCX",
  [ATTACHMENT_XLSX_CONTENT_TYPE]: "XLSX",
  [ATTACHMENT_PPTX_CONTENT_TYPE]: "PPTX",
} as const satisfies Record<AttachmentContentType, AttachmentKind>;

export function attachmentKindForContentType(
  contentType: AttachmentContentType,
): AttachmentKind {
  return ATTACHMENT_KIND_BY_CONTENT_TYPE[contentType];
}

export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1_024 * 1_024;
export const MAX_PDF_ATTACHMENT_BYTES = 25 * 1_024 * 1_024;
export const MAX_OFFICE_ATTACHMENT_BYTES = 20 * 1_024 * 1_024;

const MAX_ATTACHMENT_BYTES_BY_KIND = {
  IMAGE: MAX_IMAGE_ATTACHMENT_BYTES,
  PDF: MAX_PDF_ATTACHMENT_BYTES,
  DOCX: MAX_OFFICE_ATTACHMENT_BYTES,
  XLSX: MAX_OFFICE_ATTACHMENT_BYTES,
  PPTX: MAX_OFFICE_ATTACHMENT_BYTES,
} as const satisfies Record<AttachmentKind, number>;

export function maximumAttachmentBytesForKind(kind: AttachmentKind): number {
  return MAX_ATTACHMENT_BYTES_BY_KIND[kind];
}

export const MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES = 50 * 1_024 * 1_024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_DIMENSION = 8_192;
export const MAX_ATTACHMENT_OUTPUT_DIMENSION = 4_096;
export const ATTACHMENT_THUMBNAIL_DIMENSION = 480;
