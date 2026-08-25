import type { ErrorRequestHandler } from "express";

import { AppError } from "../../shared/errors/app-error.js";

interface ErrorDescriptor {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeError(error: unknown): ErrorDescriptor {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  if (isRecord(error)) {
    if (error.type === "entity.parse.failed") {
      return {
        statusCode: 400,
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON",
      };
    }

    if (error.type === "entity.too.large") {
      return {
        statusCode: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large",
      };
    }
  }

  return {
    statusCode: 500,
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred",
  };
}

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  const descriptor = normalizeError(error);
  const logContext = {
    err: error,
    requestId: request.requestId,
    method: request.method,
    path: request.originalUrl,
  };

  if (descriptor.statusCode >= 500) {
    request.log.error(logContext, "Request failed");
  } else {
    request.log.warn(logContext, "Request rejected");
  }

  const body: ErrorResponse = {
    error: {
      code: descriptor.code,
      message: descriptor.message,
      ...(descriptor.details === undefined
        ? {}
        : { details: descriptor.details }),
      requestId: request.requestId,
    },
  };

  response.status(descriptor.statusCode).json(body);
};
