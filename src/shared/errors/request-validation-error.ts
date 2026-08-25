import { AppError } from "./app-error.js";
import type { ValidationIssue } from "../validation/format-zod-issues.js";

export class RequestValidationError extends AppError {
  constructor(
    issues: readonly ValidationIssue[],
    message = "The request is invalid",
  ) {
    super({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message,
      details: { issues },
    });

    this.name = "RequestValidationError";
  }
}
