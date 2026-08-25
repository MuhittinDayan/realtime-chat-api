import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { pinoHttp } from "pino-http";

import { logger } from "../../shared/logging/logger.js";

type RequestWithRequestId = IncomingMessage & {
  requestId?: unknown;
};

function getRequestId(request: IncomingMessage): string {
  const requestId = (request as RequestWithRequestId).requestId;

  return typeof requestId === "string" ? requestId : randomUUID();
}

export const requestLogger = pinoHttp({
  logger,
  genReqId: getRequestId,
  customProps: (request) => ({
    requestId: getRequestId(request),
  }),
  customLogLevel: (_request, response, error) => {
    if (error !== undefined || response.statusCode >= 500) {
      return "error";
    }

    if (response.statusCode >= 400) {
      return "warn";
    }

    return "info";
  },
});
