import { randomUUID } from "node:crypto";

import type { RequestHandler } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export const requestId: RequestHandler = (request, response, next) => {
  const candidate = request.header("x-request-id")?.trim();
  const id =
    candidate !== undefined && REQUEST_ID_PATTERN.test(candidate)
      ? candidate
      : randomUUID();

  request.requestId = id;
  response.setHeader("x-request-id", id);
  next();
};
