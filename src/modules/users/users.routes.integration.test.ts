import { Router, type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { createHttpRateLimiter } from "../../http/middleware/rate-limit.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { UsersController, type UsersHttpService } from "./users.controller.js";
import type { SearchUsersQuery, UpdateCurrentUserInput } from "./users.schema.js";
import type { CurrentUserProfile, SearchUsersResult } from "./users.service.js";
import { createUsersRouter } from "./users.routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: USER_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeUsersService implements UsersHttpService {
  input: { currentUserId: string; query: SearchUsersQuery } | null = null;
  updateInput: { currentUserId: string; input: UpdateCurrentUserInput } | null = null;
  updateError: unknown = null;

  async searchUsers(
    currentUserId: string,
    input: SearchUsersQuery,
  ): Promise<SearchUsersResult> {
    this.input = { currentUserId, query: input };
    return {
      items: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          username: "bob",
          displayName: "Bob",
          avatarUrl: null,
        },
      ],
      nextCursor: null,
    };
  }

  async updateCurrentUser(
    currentUserId: string,
    input: UpdateCurrentUserInput,
  ): Promise<CurrentUserProfile> {
    this.updateInput = { currentUserId, input };
    if (this.updateError !== null) {
      throw this.updateError;
    }
    return {
      id: currentUserId,
      email: "alice@example.com",
      username: input.username ?? "alice",
      displayName: input.displayName ?? "Alice",
      avatarUrl: null,
      status: "ACTIVE",
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    };
  }
}

const noRateLimit: RequestHandler = (_request, _response, next) => next();

function createTestApp(
  service: UsersHttpService,
  searchRateLimitMiddleware: RequestHandler = noRateLimit,
) {
  const apiRouter = Router();
  apiRouter.use(
    "/users",
    createUsersRouter({
      controller: new UsersController(service),
      authenticationMiddleware: createAuthenticationMiddleware(
        new FakeAuthenticator(),
      ),
      searchRateLimitMiddleware,
    }),
  );
  return createApp({ apiRouter });
}

describe("users HTTP routes", () => {
  it("rate limits search per authenticated user", async () => {
    const app = createTestApp(
      new FakeUsersService(),
      createHttpRateLimiter({
        identifier: "test-user-search",
        windowMs: 60_000,
        limit: 1,
        scope: "user",
      }),
    );

    await request(app)
      .get("/api/v1/users?query=bo")
      .set("Authorization", "Bearer token")
      .expect(200);
    const rejected = await request(app)
      .get("/api/v1/users?query=bo")
      .set("Authorization", "Bearer token")
      .expect(429);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("requires authentication", async () => {
    const response = await request(createTestApp(new FakeUsersService()))
      .get("/api/v1/users?query=bo")
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("searches as the authenticated user with trimmed input", async () => {
    const service = new FakeUsersService();
    const response = await request(createTestApp(service))
      .get("/api/v1/users?query=%20bo%20&limit=10")
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(service.input).toEqual({
      currentUserId: USER_ID,
      query: { query: "bo", limit: 10 },
    });
    expect(response.body.items[0]).not.toHaveProperty("email");
  });

  it.each(["", "a"])("rejects an insufficient query: %j", async (query) => {
    const service = new FakeUsersService();
    const response = await request(createTestApp(service))
      .get(`/api/v1/users?query=${query}`)
      .set("Authorization", "Bearer token")
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.input).toBeNull();
  });

  it("updates the authenticated user's profile", async () => {
    const service = new FakeUsersService();
    const response = await request(createTestApp(service))
      .patch("/api/v1/users/me")
      .set("Authorization", "Bearer token")
      .send({ username: "new-alice", displayName: "New Alice" })
      .expect(200);

    expect(service.updateInput).toEqual({
      currentUserId: USER_ID,
      input: { username: "new-alice", displayName: "New Alice" },
    });
    expect(response.body.user).toEqual(
      expect.objectContaining({
        id: USER_ID,
        username: "new-alice",
        displayName: "New Alice",
      }),
    );
  });

  it("requires at least one editable profile field", async () => {
    const service = new FakeUsersService();
    const response = await request(createTestApp(service))
      .patch("/api/v1/users/me")
      .set("Authorization", "Bearer token")
      .send({})
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.updateInput).toBeNull();
  });
});
