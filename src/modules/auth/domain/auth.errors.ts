import { AppError } from "../../../shared/errors/app-error.js";
export { RequestValidationError } from "../../../shared/errors/request-validation-error.js";

const UNAUTHORIZED_STATUS_CODE = 401;

export class InvalidTokenError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "INVALID_TOKEN",
      message: "The token is invalid",
      ...(cause === undefined ? {} : { cause }),
    });

    this.name = "InvalidTokenError";
  }
}

export class SessionRevokedError extends AppError {
  constructor() {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "SESSION_REVOKED",
      message: "The session has been revoked",
    });

    this.name = "SessionRevokedError";
  }
}

export class SessionExpiredError extends AppError {
  constructor() {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "SESSION_EXPIRED",
      message: "The session has expired",
    });

    this.name = "SessionExpiredError";
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor() {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "AUTHENTICATION_REQUIRED",
      message: "Authentication is required",
    });

    this.name = "AuthenticationRequiredError";
  }
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "INVALID_CREDENTIALS",
      message: "The email or password is incorrect",
    });

    this.name = "InvalidCredentialsError";
  }
}

export class InvalidRefreshTokenError extends AppError {
  constructor() {
    super({
      statusCode: UNAUTHORIZED_STATUS_CODE,
      code: "INVALID_REFRESH_TOKEN",
      message: "The refresh token is invalid",
    });

    this.name = "InvalidRefreshTokenError";
  }
}

export class EmailAlreadyInUseError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "EMAIL_ALREADY_IN_USE",
      message: "The email is already in use",
    });

    this.name = "EmailAlreadyInUseError";
  }
}

export class UsernameAlreadyInUseError extends AppError {
  constructor() {
    super({
      statusCode: 409,
      code: "USERNAME_ALREADY_IN_USE",
      message: "The username is already in use",
    });

    this.name = "UsernameAlreadyInUseError";
  }
}

export class UserAlreadyExistsError extends AppError {
  constructor(cause?: unknown) {
    super({
      statusCode: 409,
      code: "USER_ALREADY_EXISTS",
      message: "A user with these details already exists",
      ...(cause === undefined ? {} : { cause }),
    });

    this.name = "UserAlreadyExistsError";
  }
}

export class CsrfValidationError extends AppError {
  constructor() {
    super({
      statusCode: 403,
      code: "CSRF_VALIDATION_FAILED",
      message: "The request origin is not allowed",
    });

    this.name = "CsrfValidationError";
  }
}
