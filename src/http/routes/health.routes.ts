import { Router } from "express";

import { prisma } from "../../infrastructure/database/prisma.js";

export const healthRouter = Router();

healthRouter.get("/healthz", (_request, response): void => {
  response.status(200).json({ status: "ok" });
});

healthRouter.get("/readyz", async (request, response): Promise<void> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    response.status(200).json({ status: "ready" });
  } catch (error: unknown) {
    request.log.warn(
      { err: error, requestId: request.requestId },
      "Readiness check failed",
    );
    response.status(503).json({ status: "not_ready" });
  }
});
