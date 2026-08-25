import type { RequestHandler } from "express";

import { AppError } from "../../shared/errors/app-error.js";

export const notFoundHandler: RequestHandler = (request, _response, next) => {
  next(
    new AppError({
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
      message: "Route not found",
      details: {
        method: request.method,
        path: request.originalUrl,
      },
    }),
  );
};
