import { Router, type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { createHttpRateLimiter } from "../../http/middleware/rate-limit.js";
import type { Clock } from "../../shared/time/clock.js";
import {
  EmailAlreadyInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
} from "./auth.errors.js";
import { AuthController, type AuthHttpService } from "./auth.controller.js";
import {
  createAuthenticationMiddleware,
  createTrustedOriginMiddleware,
  type AccessAuthenticator,
} from "./auth.middleware.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import type {
  AuthResult,
  PublicUser,
  RefreshResult,
} from "./auth.service.js";
import { createAuthRouter } from "./auth.routes.js";
import { HttpRefreshCookieManager } from "./refresh-cookie.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const JWT_ID = "33333333-3333-4333-8333-333333333333";
const TRUSTED_ORIGIN = "https://chat.example.com";

const publicUser: PublicUser = {
  id: USER_ID,
  email: "alice@example.com",
  username: "alice",
  displayName: "Alice",
  avatarUrl: null,
  status: "ACTIVE",
  createdAt: NOW,
};

const authResult: AuthResult = {
  user: publicUser,
  accessToken: "issued-access-token",
  accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000),
  refreshToken: "issued-refresh-token",
  refreshTokenExpiresAt: new Date(
    NOW.getTime() + 30 * 24 * 60 * 60 * 1_000,
  ),
};

const refreshResult: RefreshResult = {
  accessToken: "rotated-access-token",
  accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000),
  refreshToken: "rotated-refresh-token",
  refreshTokenExpiresAt: authResult.refreshTokenExpiresAt,
};

class FakeAuthHttpService implements AuthHttpService {
  registerInput: RegisterInput | null = null;
  loginInput: LoginInput | null = null;
  refreshInput: string | null = null;
  logoutInput: { sessionId: string; userId: string } | null = null;
  registerError: unknown = null;
  loginError: unknown = null;
  refreshError: unknown = null;
  currentUserError: unknown = null;

  async register(input: RegisterInput): Promise<AuthResult> {
    this.registerInput = input;

    if (this.registerError !== null) {
      throw this.registerError;
    }

    return authResult;
  }

  async login(input: LoginInput): Promise<AuthResult> {
    this.loginInput = input;

    if (this.loginError !== null) {
      throw this.loginError;
    }

    return authResult;
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    this.refreshInput = refreshToken;

    if (this.refreshError !== null) {
      throw this.refreshError;
    }

    return refreshResult;
  }

  async logout(input: {
    sessionId: string;
    userId: string;
  }): Promise<void> {
    this.logoutInput = input;
  }

  async getCurrentUser(_userId: string): Promise<PublicUser> {
    if (this.currentUserError !== null) {
      throw this.currentUserError;
    }

    return publicUser;
  }
}

class FakeAccessAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken(token: string) {
    if (token !== "valid-access-token") {
      throw new InvalidTokenError();
    }

    return {
      userId: USER_ID,
      sessionId: SESSION_ID,
      jwtId: JWT_ID,
    };
  }
}

const fixedClock: Clock = {
  now: () => NOW,
};

interface TestAppOptions {
  enforceOrigin?: boolean;
  secureCookie?: boolean;
  loginRateLimitMiddleware?: RequestHandler;
  registerRateLimitMiddleware?: RequestHandler;
  refreshRateLimitMiddleware?: RequestHandler;
}

const noRateLimit: RequestHandler = (_request, _response, next) => next();

function createTestApp(
  service: AuthHttpService,
  options: TestAppOptions = {},
) {
  const controller = new AuthController({
    authService: service,
    refreshCookieManager: new HttpRefreshCookieManager({
      secure: options.secureCookie ?? false,
      clock: fixedClock,
    }),
  });
  const authRouter = createAuthRouter({
    controller,
    authenticationMiddleware: createAuthenticationMiddleware(
      new FakeAccessAuthenticator(),
    ),
    trustedOriginMiddleware: createTrustedOriginMiddleware({
      trustedOrigin: TRUSTED_ORIGIN,
      enforce: options.enforceOrigin ?? false,
    }),
    loginRateLimitMiddleware:
      options.loginRateLimitMiddleware ?? noRateLimit,
    registerRateLimitMiddleware:
      options.registerRateLimitMiddleware ?? noRateLimit,
    refreshRateLimitMiddleware:
      options.refreshRateLimitMiddleware ?? noRateLimit,
  });
  const apiRouter = Router();
  apiRouter.use("/auth", authRouter);

  return createApp({ apiRouter });
}

function readSetCookieHeader(headers: unknown): readonly string[] {
  if (typeof headers !== "object" || headers === null) {
    return [];
  }

  const value: unknown = Reflect.get(headers, "set-cookie");

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }

  return [];
}

describe("auth HTTP routes", () => {
  it("rate limits login by IP with the standard 429 response", async () => {
    const service = new FakeAuthHttpService();
    const app = createTestApp(service, {
      loginRateLimitMiddleware: createHttpRateLimiter({
        identifier: "test-auth-login",
        windowMs: 60_000,
        limit: 1,
        scope: "ip",
      }),
    });
    const payload = {
      email: "alice@example.com",
      password: "correct-password",
    };

    await request(app).post("/api/v1/auth/login").send(payload).expect(200);
    const rejected = await request(app)
      .post("/api/v1/auth/login")
      .send(payload)
      .expect(429);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(rejected.body.error.message).toBe("Too many requests");
    expect(typeof rejected.body.error.requestId).toBe("string");
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rate limits registration independently from login", async () => {
    const service = new FakeAuthHttpService();
    const app = createTestApp(service, {
      registerRateLimitMiddleware: createHttpRateLimiter({
        identifier: "test-auth-register",
        windowMs: 60_000,
        limit: 1,
        scope: "ip",
      }),
    });
    const payload = {
      email: "alice@example.com",
      username: "alice",
      displayName: "Alice",
      password: "correct-password",
    };

    await request(app).post("/api/v1/auth/register").send(payload).expect(201);
    const rejected = await request(app)
      .post("/api/v1/auth/register")
      .send(payload)
      .expect(429);
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: payload.email, password: payload.password })
      .expect(200);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("rate limits refresh independently from other auth routes", async () => {
    const service = new FakeAuthHttpService();
    const app = createTestApp(service, {
      refreshRateLimitMiddleware: createHttpRateLimiter({
        identifier: "test-auth-refresh",
        windowMs: 60_000,
        limit: 1,
        scope: "ip",
      }),
    });

    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(200);
    const rejected = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(429);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("registers a user, normalizes email, and sets the refresh cookie", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/register")
      .send({
        email: " Alice@Example.COM ",
        username: "alice",
        displayName: "Alice",
        password: "correct-password",
      })
      .expect(201);
    const setCookie = readSetCookieHeader(response.headers).join("; ");

    expect(service.registerInput?.email).toBe("alice@example.com");
    expect(response.body).toEqual({
      user: { ...publicUser, createdAt: NOW.toISOString() },
      accessToken: "issued-access-token",
    });
    expect(response.body).not.toHaveProperty("refreshToken");
    expect(setCookie).toContain("chat_refresh_token=issued-refresh-token");
    expect(setCookie).toContain("Path=/api/v1/auth");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects an invalid registration body with the standard error format", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/register")
      .send({
        email: "not-an-email",
        username: "alice",
        displayName: "Alice",
        password: "short",
      })
      .expect(400);

    expect(service.registerInput).toBeNull();
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(typeof response.body.error.requestId).toBe("string");
  });

  it("maps a duplicate registration to conflict", async () => {
    const service = new FakeAuthHttpService();
    service.registerError = new EmailAlreadyInUseError();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/register")
      .send({
        email: "alice@example.com",
        username: "alice",
        displayName: "Alice",
        password: "correct-password",
      })
      .expect(409);

    expect(response.body.error.code).toBe("EMAIL_ALREADY_IN_USE");
  });

  it("logs in and sets a production Secure refresh cookie", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(
      createTestApp(service, { secureCookie: true }),
    )
      .post("/api/v1/auth/login")
      .send({ email: "ALICE@EXAMPLE.COM", password: "correct-password" })
      .expect(200);
    const setCookie = readSetCookieHeader(response.headers).join("; ");

    expect(service.loginInput?.email).toBe("alice@example.com");
    expect(setCookie).toContain("Secure");
    expect(response.body.accessToken).toBe("issued-access-token");
  });

  it("uses the refresh cookie and rotates it", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/refresh")
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(200);
    const setCookie = readSetCookieHeader(response.headers).join("; ");

    expect(service.refreshInput).toBe("old-refresh-token");
    expect(response.body).toEqual({ accessToken: "rotated-access-token" });
    expect(response.body).not.toHaveProperty("refreshToken");
    expect(setCookie).toContain("chat_refresh_token=rotated-refresh-token");
  });

  it("rejects refresh when the cookie is missing", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/refresh")
      .expect(401);

    expect(response.body.error.code).toBe("INVALID_REFRESH_TOKEN");
    expect(service.refreshInput).toBeNull();
  });

  it("enforces the trusted Origin for production cookie requests", async () => {
    const service = new FakeAuthHttpService();
    const app = createTestApp(service, { enforceOrigin: true });

    const rejected = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(403);
    await request(app)
      .post("/api/v1/auth/refresh")
      .set("Origin", TRUSTED_ORIGIN)
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(200);

    expect(rejected.body.error.code).toBe("CSRF_VALIDATION_FAILED");
  });

  it("exposes credentialed CORS only for the configured frontend origin", async () => {
    const service = new FakeAuthHttpService();
    const app = createTestApp(service);

    const allowed = await request(app)
      .options("/api/v1/auth/refresh")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    const disallowed = await request(app)
      .options("/api/v1/auth/refresh")
      .set("Origin", "https://attacker.example.com")
      .set("Access-Control-Request-Method", "POST")
      .expect(204);

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
    expect(disallowed.headers["access-control-allow-origin"]).not.toBe(
      "https://attacker.example.com",
    );
  });

  it("does not clear the cookie when refresh rotation loses a race", async () => {
    const service = new FakeAuthHttpService();
    service.refreshError = new InvalidTokenError();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/refresh")
      .set("Cookie", "chat_refresh_token=stale-refresh-token")
      .expect(401);

    expect(readSetCookieHeader(response.headers)).toHaveLength(0);
  });

  it("revokes the authenticated session and clears the cookie", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/logout")
      .set("Authorization", "Bearer valid-access-token")
      .set("Cookie", "chat_refresh_token=old-refresh-token")
      .expect(204);
    const setCookie = readSetCookieHeader(response.headers).join("; ");

    expect(service.logoutInput).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
    expect(setCookie).toContain("chat_refresh_token=");
    expect(setCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(setCookie).toContain("Path=/api/v1/auth");
  });

  it("returns the authenticated public user", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer valid-access-token")
      .expect(200);

    expect(response.body.user).toEqual({
      ...publicUser,
      createdAt: NOW.toISOString(),
    });
    expect(response.body.user).not.toHaveProperty("passwordHash");
  });

  it("rejects an invalid access token", async () => {
    const service = new FakeAuthHttpService();
    const response = await request(createTestApp(service))
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer invalid-access-token")
      .expect(401);

    expect(response.body.error.code).toBe("INVALID_TOKEN");
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer realm="chat-api"',
    );
  });

  it("uses the generic credential error response", async () => {
    const service = new FakeAuthHttpService();
    service.loginError = new InvalidCredentialsError();
    const response = await request(createTestApp(service))
      .post("/api/v1/auth/login")
      .send({ email: "unknown@example.com", password: "wrong-password" })
      .expect(401);

    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});
