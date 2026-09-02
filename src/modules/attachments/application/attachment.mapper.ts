import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PDF_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  type AttachmentContentType,
} from "../domain/attachment.constants.ts";
import { AttachmentUploadConflictError } from "../domain/attachment.errors.ts";
import type { AttachmentRecord } from "../persistence/attachment.repository.ts";
import type { MessageAttachmentDto } from "./attachment.types.js";

export function toMessageAttachmentDto(
  attachment: AttachmentRecord,
): MessageAttachmentDto {
  if (attachment.status !== "READY" || attachment.readyObjectKey === null) {
    throw new AttachmentUploadConflictError();
  }

  const basePath =
    `/api/v1/conversations/${attachment.conversationId}` +
    `/attachments/${attachment.id}`;
  const kind = attachment.kind;

  switch (kind) {
    case "IMAGE":
      if (
        attachment.width === null ||
        attachment.height === null ||
        attachment.thumbnailObjectKey === null
      ) {
        throw new AttachmentUploadConflictError();
      }

      return {
        id: attachment.id,
        kind: "IMAGE",
        originalFileName: attachment.originalFileName,
        contentType: "image/webp",
        width: attachment.width,
        height: attachment.height,
        url: `${basePath}/original`,
        thumbnailUrl: `${basePath}/thumbnail`,
      };
    case "PDF":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_PDF_CONTENT_TYPE,
      );
      return {
        id: attachment.id,
        kind: "PDF",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_PDF_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "DOCX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_DOCX_CONTENT_TYPE,
      );
      return {
        id: attachment.id,
        kind: "DOCX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_DOCX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "XLSX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_XLSX_CONTENT_TYPE,
      );
      return {
        id: attachment.id,
        kind: "XLSX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_XLSX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "PPTX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_PPTX_CONTENT_TYPE,
      );
      return {
        id: attachment.id,
        kind: "PPTX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_PPTX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    default:
      return assertNever(kind);
  }
}

function requireDetectedContentType(
  actual: string | null,
  expected: AttachmentContentType,
): void {
  if (actual !== expected) {
    throw new AttachmentUploadConflictError();
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported attachment kind: ${String(value)}`);
}
