import type { RequestHandler } from "express";
import helmet from "helmet";

import { env } from "../../config/env.js";

export function createSecurityHeadersMiddleware(
  production: boolean,
): RequestHandler {
  return helmet({
    strictTransportSecurity: production ? {} : false,
  });
}

export const securityHeaders = createSecurityHeadersMiddleware(
  env.NODE_ENV === "production",
);
