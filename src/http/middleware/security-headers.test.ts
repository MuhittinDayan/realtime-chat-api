import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createSecurityHeadersMiddleware } from "./security-headers.js";

function createHeaderTestApp(production: boolean) {
  const app = express();

  app.use(createSecurityHeadersMiddleware(production));
  app.get("/", (_request, response) => response.sendStatus(204));

  return app;
}

describe("security headers", () => {
  it("sets Helmet defaults without HSTS outside production", async () => {
    const response = await request(createHeaderTestApp(false))
      .get("/")
      .expect(204);

    expect(response.headers["strict-transport-security"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'self'",
    );
  });

  it("sets Helmet's default HSTS policy in production", async () => {
    const response = await request(createHeaderTestApp(true))
      .get("/")
      .expect(204);

    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });
});
