import express, { type Express, type Router } from "express";

import { env } from "./config/env.js";
import { swaggerRouter } from "./http/docs/swagger.route.js";
import { corsMiddleware } from "./http/middleware/cors.js";
import { errorHandler } from "./http/middleware/error-handler.js";
import { jsonBodyParser } from "./http/middleware/json-body-parser.js";
import { notFoundHandler } from "./http/middleware/not-found.js";
import { requestId } from "./http/middleware/request-id.js";
import { requestLogger } from "./http/middleware/request-logger.js";
import { securityHeaders } from "./http/middleware/security-headers.js";
import { apiV1Router } from "./http/routes/index.js";

export interface CreateAppOptions {
  apiRouter?: Router;
  swaggerEnabled?: boolean;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(requestId);
  app.use(requestLogger);
  app.use(corsMiddleware);
  app.use(jsonBodyParser);

  const swaggerEnabled =
    options.swaggerEnabled ?? env.NODE_ENV !== "production";

  if (swaggerEnabled) {
    app.use("/api-docs", swaggerRouter);
  }

  app.use("/api/v1", options.apiRouter ?? apiV1Router);
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
