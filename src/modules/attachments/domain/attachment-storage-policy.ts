import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PDF_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  type AttachmentContentType,
  type AttachmentKind,
} from "./attachment.constants.ts";

export function storageKeysForKind(
  kind: AttachmentKind,
  ownerId: string,
  assetId: string,
): { readyObjectKey: string; thumbnailObjectKey: string | null } {
  const readyPrefix = `ready/${ownerId}/${assetId}`;

  switch (kind) {
    case "IMAGE":
      return {
        readyObjectKey: `${readyPrefix}/original.webp`,
        thumbnailObjectKey: `${readyPrefix}/thumbnail.webp`,
      };
    case "PDF":
      return {
        readyObjectKey: `${readyPrefix}/original.pdf`,
        thumbnailObjectKey: null,
      };
    case "DOCX":
      return {
        readyObjectKey: `${readyPrefix}/original.docx`,
        thumbnailObjectKey: null,
      };
    case "XLSX":
      return {
        readyObjectKey: `${readyPrefix}/original.xlsx`,
        thumbnailObjectKey: null,
      };
    case "PPTX":
      return {
        readyObjectKey: `${readyPrefix}/original.pptx`,
        thumbnailObjectKey: null,
      };
    default:
      return assertNever(kind);
  }
}

export function downloadResponseMetadataForKind(
  kind: AttachmentKind,
  originalFileName: string,
): {
  responseContentDisposition?: string;
  responseContentType?: AttachmentContentType;
} {
  switch (kind) {
    case "IMAGE":
      return {};
    case "PDF":
      return {
        responseContentDisposition: buildPdfContentDisposition(originalFileName),
        responseContentType: ATTACHMENT_PDF_CONTENT_TYPE,
      };
    case "DOCX":
      return {
        responseContentDisposition: buildAttachmentContentDisposition(
          originalFileName,
          "attachment.docx",
        ),
        responseContentType: ATTACHMENT_DOCX_CONTENT_TYPE,
      };
    case "XLSX":
      return {
        responseContentDisposition: buildAttachmentContentDisposition(
          originalFileName,
          "attachment.xlsx",
        ),
        responseContentType: ATTACHMENT_XLSX_CONTENT_TYPE,
      };
    case "PPTX":
      return {
        responseContentDisposition: buildAttachmentContentDisposition(
          originalFileName,
          "attachment.pptx",
        ),
        responseContentType: ATTACHMENT_PPTX_CONTENT_TYPE,
      };
    default:
      return assertNever(kind);
  }
}

export function isOriginalFileNameAllowedForKind(
  originalFileName: string,
  kind: AttachmentKind,
): boolean {
  const lowerCaseName = originalFileName.trim().toLowerCase();

  switch (kind) {
    case "IMAGE":
    case "PDF":
      return true;
    case "DOCX":
      return lowerCaseName.endsWith(".docx");
    case "XLSX":
      return lowerCaseName.endsWith(".xlsx");
    case "PPTX":
      return lowerCaseName.endsWith(".pptx");
    default:
      return assertNever(kind);
  }
}

export function buildPdfContentDisposition(originalFileName: string): string {
  return buildAttachmentContentDisposition(originalFileName, "attachment.pdf");
}

function buildAttachmentContentDisposition(
  originalFileName: string,
  fallbackFileName: string,
): string {
  const sanitized = originalFileName
    .replace(/[\u0000-\u001f\u007f/\\]+/gu, "_")
    .trim();
  const safeName = sanitized.length === 0 ? fallbackFileName : sanitized;
  const asciiFallback =
    safeName
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/gu, "_")
      .replace(/["\\]/gu, "_") || fallbackFileName;
  const encoded = encodeURIComponent(safeName).replace(
    /[!'()*]/gu,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported attachment kind: ${String(value)}`);
}
