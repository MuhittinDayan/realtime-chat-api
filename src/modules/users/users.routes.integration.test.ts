import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { UsersController, type UsersHttpService } from "./users.controller.js";
import type { SearchUsersQuery } from "./users.schema.js";
import type { SearchUsersResult } from "./users.service.js";
import { createUsersRouter } from "./users.routes.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: USER_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeUsersService implements UsersHttpService {
  input: { currentUserId: string; query: SearchUsersQuery } | null = null;

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
}

function createTestApp(service: UsersHttpService) {
  const apiRouter = Router();
  apiRouter.use(
    "/users",
    createUsersRouter({
      controller: new UsersController(service),
      authenticationMiddleware: createAuthenticationMiddleware(
        new FakeAuthenticator(),
      ),
    }),
  );
  return createApp({ apiRouter });
}

describe("users HTTP routes", () => {
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
});
