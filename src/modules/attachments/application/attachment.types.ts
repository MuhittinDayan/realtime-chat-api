import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  type AttachmentKind,
} from "../domain/attachment.constants.ts";

export interface AttachmentConversationAccessService {
  isActiveMember(conversationId: string, userId: string): Promise<boolean>;
}

export interface AttachmentServiceConfig {
  attachmentBucket: string;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
}

export interface AttachmentServiceLogger {
  warn(context: object, message: string): void;
}

export interface CreateAttachmentUploadInput {
  contentType: string;
  contentLength: number;
  originalFileName: string;
}

export interface AttachmentUploadIntent {
  attachmentId: string;
  upload: {
    url: string;
    method: "PUT";
    headers: Readonly<Record<string, string>>;
    expiresAt: Date;
  };
}

export interface BaseMessageAttachmentDto {
  id: string;
  originalFileName: string;
  kind: AttachmentKind;
  url: string;
}

export interface ImageMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "IMAGE";
  contentType: "image/webp";
  width: number;
  height: number;
  thumbnailUrl: string;
}

export interface PdfMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "PDF";
  contentType: "application/pdf";
}

export interface DocxMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "DOCX";
  contentType: typeof ATTACHMENT_DOCX_CONTENT_TYPE;
}

export interface XlsxMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "XLSX";
  contentType: typeof ATTACHMENT_XLSX_CONTENT_TYPE;
}

export interface PptxMessageAttachmentDto extends BaseMessageAttachmentDto {
  kind: "PPTX";
  contentType: typeof ATTACHMENT_PPTX_CONTENT_TYPE;
}

export type MessageAttachmentDto =
  | ImageMessageAttachmentDto
  | PdfMessageAttachmentDto
  | DocxMessageAttachmentDto
  | XlsxMessageAttachmentDto
  | PptxMessageAttachmentDto;

export type AttachmentVariant = "original" | "thumbnail";
