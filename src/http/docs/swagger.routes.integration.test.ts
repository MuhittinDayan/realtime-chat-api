import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";

function createSwaggerTestApp(swaggerEnabled: boolean) {
  return createApp({
    apiRouter: Router(),
    swaggerEnabled,
  });
}

describe("Swagger documentation routes", () => {
  it("serves Swagger UI and the source OpenAPI YAML when enabled", async () => {
    const app = createSwaggerTestApp(true);
    const uiResponse = await request(app).get("/api-docs/").expect(200);
    const specResponse = await request(app)
      .get("/api-docs/openapi.yaml")
      .expect(200);

    expect(uiResponse.text).toContain("Swagger UI");
    expect(uiResponse.headers["content-security-policy"]).toBeUndefined();
    expect(specResponse.headers["content-type"]).toContain(
      "application/yaml",
    );
    expect(specResponse.text).toMatch(/^openapi: 3\.1\.0/m);
  });

  it("does not expose Swagger routes when disabled", async () => {
    const response = await request(createSwaggerTestApp(false))
      .get("/api-docs/")
      .expect(404);

    expect(response.body.error.code).toBe("ROUTE_NOT_FOUND");
  });
});
