import { AppError } from "../../../shared/errors/app-error.ts";

export class UnsupportedAttachmentFormatError extends AppError {
  constructor() {
    super({
      statusCode: 400,
      code: "UNSUPPORTED_ATTACHMENT_FORMAT",
      message: "Attachment format is not supported; use JPEG, PNG, WebP, or PDF",
    });
    this.name = "UnsupportedAttachmentFormatError";
  }
}

export class AttachmentUploadNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "ATTACHMENT_UPLOAD_NOT_FOUND",
      message: "The attachment upload was not found",
    });
    this.name = "AttachmentUploadNotFoundError";
  }
}

export class AttachmentNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "ATTACHMENT_NOT_FOUND",
      message: "The attachment was not found",
    });
    this.name = "AttachmentNotFoundError";
  }
}

export class AttachmentUploadExpiredError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "ATTACHMENT_UPLOAD_EXPIRED",
      message: "The attachment upload has expired",
    });
    this.name = "AttachmentUploadExpiredError";
  }
}

export class AttachmentUploadIncompleteError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "ATTACHMENT_UPLOAD_INCOMPLETE",
      message: "The attachment upload has not completed",
    });
    this.name = "AttachmentUploadIncompleteError";
  }
}

export class AttachmentUploadConflictError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "ATTACHMENT_UPLOAD_CONFLICT",
      message: "The attachment upload cannot be completed",
    });
    this.name = "AttachmentUploadConflictError";
  }
}

export class InvalidAttachmentFileError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 422,
      code: "INVALID_ATTACHMENT_FILE",
      message: "The uploaded file is not a valid supported attachment",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "InvalidAttachmentFileError";
  }
}

export class AttachmentKindMismatchError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 422,
      code: "KIND_MISMATCH",
      message: "The uploaded file kind does not match the upload intent",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "AttachmentKindMismatchError";
  }
}

export class AttachmentScanUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 503,
      code: "ATTACHMENT_SCAN_UNAVAILABLE",
      message: "Attachment malware scanning is temporarily unavailable",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "AttachmentScanUnavailableError";
  }
}

export class AttachmentStorageUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 503,
      code: "ATTACHMENT_STORAGE_UNAVAILABLE",
      message: "Attachment storage is temporarily unavailable",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "AttachmentStorageUnavailableError";
  }
}

export class AttachmentBindingError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "ATTACHMENT_BINDING_CONFLICT",
      message: "One or more attachments cannot be bound to the message",
    });
    this.name = "AttachmentBindingError";
  }
}

export class MessageAttachmentsTotalSizeExceededError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "MESSAGE_ATTACHMENTS_TOTAL_SIZE_EXCEEDED",
      message: "The message attachments exceed the total size limit",
    });
    this.name = "MessageAttachmentsTotalSizeExceededError";
  }
}
