import { AppError } from "../../shared/errors/app-error.js";

export class UnsupportedAvatarFormatError extends AppError {
  constructor() {
    super({
      statusCode: 400,
      code: "UNSUPPORTED_AVATAR_FORMAT",
      message: "Avatar format is not supported; use JPEG, PNG, or WebP",
    });
    this.name = "UnsupportedAvatarFormatError";
  }
}

export class AvatarUploadNotFoundError extends AppError {
  constructor() {
    super({
      statusCode: 404,
      code: "AVATAR_UPLOAD_NOT_FOUND",
      message: "The avatar upload was not found",
    });
    this.name = "AvatarUploadNotFoundError";
  }
}

export class AvatarUploadExpiredError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "AVATAR_UPLOAD_EXPIRED",
      message: "The avatar upload has expired",
    });
    this.name = "AvatarUploadExpiredError";
  }
}

export class AvatarUploadIncompleteError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "AVATAR_UPLOAD_INCOMPLETE",
      message: "The avatar upload has not completed",
    });
    this.name = "AvatarUploadIncompleteError";
  }
}

export class AvatarUploadConflictError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "AVATAR_UPLOAD_CONFLICT",
      message: "The avatar upload cannot be completed",
    });
    this.name = "AvatarUploadConflictError";
  }
}

export class InvalidAvatarFileError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 422,
      code: "INVALID_AVATAR_FILE",
      message: "The uploaded file is not a valid supported avatar image",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "InvalidAvatarFileError";
  }
}

export class AvatarStorageUnavailableError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 503,
      code: "AVATAR_STORAGE_UNAVAILABLE",
      message: "Avatar storage is temporarily unavailable",
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = "AvatarStorageUnavailableError";
  }
}

