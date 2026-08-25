import type { Request, RequestHandler, Response } from "express";
import type { ZodType } from "zod";

import { RequestValidationError } from "../../shared/errors/request-validation-error.js";

export type ValidatedRequestHandler<T> = (
  request: Request,
  response: Response,
  input: T,
) => Promise<void> | void;

function validate<T>(schema: ZodType<T>, value: unknown, rootPath: string): T {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => ({
        path:
          issue.path.length === 0
            ? rootPath
            : `${rootPath}.${issue.path.join(".")}`,
        message: issue.message,
      })),
    );
  }

  return result.data;
}

export function withValidatedBody<T>(
  schema: ZodType<T>,
  handler: ValidatedRequestHandler<T>,
): RequestHandler {
  return async (request, response): Promise<void> => {
    await handler(request, response, validate(schema, request.body, "body"));
  };
}

export function withValidatedQuery<T>(
  schema: ZodType<T>,
  handler: ValidatedRequestHandler<T>,
): RequestHandler {
  return async (request, response): Promise<void> => {
    await handler(request, response, validate(schema, request.query, "query"));
  };
}

export function withValidatedParams<T>(
  schema: ZodType<T>,
  handler: ValidatedRequestHandler<T>,
): RequestHandler {
  return async (request, response): Promise<void> => {
    await handler(request, response, validate(schema, request.params, "params"));
  };
}

export function validateParams<T>(schema: ZodType<T>): RequestHandler {
  return (request, _response, next): void => {
    validate(schema, request.params, "params");
    next();
  };
}
