import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { parse } from "yaml";

const openApiPath = fileURLToPath(
  new URL("../../../docs/openapi.yaml", import.meta.url),
);
const openApiSource = readFileSync(openApiPath, "utf8");
const openApiDocument = parse(openApiSource) as Record<string, unknown>;

export const swaggerRouter = Router();

// Limit the development-only CSP exception to the documentation route.
swaggerRouter.use((_request, response, next) => {
  response.removeHeader("Content-Security-Policy");
  next();
});

swaggerRouter.get("/openapi.yaml", (_request, response) => {
  response.type("application/yaml").send(openApiSource);
});

swaggerRouter.use(
  "/",
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument, {
    swaggerOptions: {
      persistAuthorization: true,
      withCredentials: true,
    },
  }),
);
