import { Router, type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { createHttpRateLimiter } from "../../http/middleware/rate-limit.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { UsersController, type UsersHttpService } from "../users/users.controller.js";
import type {
  SearchUsersQuery,
  UpdateCurrentUserInput,
} from "../users/users.schema.js";
import type {
  CurrentUserProfile,
  SearchUsersResult,
} from "../users/users.service.js";
import { createUsersRouter } from "../users/users.routes.js";
import { AvatarController, type AvatarHttpService } from "./avatar.controller.js";
import type { CreateAvatarUploadInput } from "./avatar.schema.js";
import type { AvatarUploadIntent } from "./avatar.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const UPLOAD_ID = "22222222-2222-4222-8222-222222222222";

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: USER_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class UnusedUsersService implements UsersHttpService {
  async searchUsers(
    _currentUserId: string,
    _input: SearchUsersQuery,
  ): Promise<SearchUsersResult> {
    return { items: [], nextCursor: null };
  }
  async updateCurrentUser(
    _currentUserId: string,
    _input: UpdateCurrentUserInput,
  ): Promise<CurrentUserProfile> {
    throw new Error("not used");
  }
}

class FakeAvatarService implements AvatarHttpService {
  createInput: { ownerId: string; input: CreateAvatarUploadInput } | null = null;
  completed: { ownerId: string; uploadId: string } | null = null;
  deletedFor: string | null = null;

  async createUpload(
    ownerId: string,
    input: CreateAvatarUploadInput,
  ): Promise<AvatarUploadIntent> {
    this.createInput = { ownerId, input };
    return {
      uploadId: UPLOAD_ID,
      upload: {
        url: "http://storage/signed",
        method: "PUT",
        headers: { "Content-Type": input.contentType },
        expiresAt: new Date("2030-01-01T00:10:00.000Z"),
      },
    };
  }

  async completeUpload(ownerId: string, uploadId: string) {
    this.completed = { ownerId, uploadId };
    return profile("http://storage/public/avatar.webp");
  }

  async deleteAvatar(ownerId: string) {
    this.deletedFor = ownerId;
    return profile(null);
  }
}

function profile(avatarUrl: string | null): CurrentUserProfile {
  return {
    id: USER_ID,
    email: "alice@example.com",
    username: "alice",
    displayName: "Alice",
    avatarUrl,
    status: "ACTIVE",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const noRateLimit: RequestHandler = (_request, _response, next) => next();

function createTestApp(
  avatarService: FakeAvatarService,
  rateLimitMiddleware: RequestHandler = noRateLimit,
) {
  const apiRouter = Router();
  apiRouter.use(
    "/users",
    createUsersRouter({
      controller: new UsersController(new UnusedUsersService()),
      avatarController: new AvatarController(avatarService),
      authenticationMiddleware: createAuthenticationMiddleware(
        new FakeAuthenticator(),
      ),
      searchRateLimitMiddleware: noRateLimit,
      avatarRateLimitMiddleware: rateLimitMiddleware,
    }),
  );

  return createApp({ apiRouter });
}

describe("avatar HTTP routes", () => {
  it("creates an authenticated upload intent", async () => {
    const service = new FakeAvatarService();
    const response = await request(createTestApp(service))
      .post("/api/v1/users/me/avatar/uploads")
      .set("Authorization", "Bearer token")
      .send({ contentType: "image/png", contentLength: 4 })
      .expect(201);

    expect(service.createInput).toEqual({
      ownerId: USER_ID,
      input: { contentType: "image/png", contentLength: 4 },
    });
    expect(response.body.upload).toEqual(
      expect.objectContaining({ method: "PUT", url: "http://storage/signed" }),
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects oversized intent bodies before calling the service", async () => {
    const service = new FakeAvatarService();
    const response = await request(createTestApp(service))
      .post("/api/v1/users/me/avatar/uploads")
      .set("Authorization", "Bearer token")
      .send({ contentType: "image/png", contentLength: 5 * 1_024 * 1_024 + 1 })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.createInput).toBeNull();
  });

  it("completes an upload and returns the updated user", async () => {
    const service = new FakeAvatarService();
    const response = await request(createTestApp(service))
      .post(`/api/v1/users/me/avatar/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(service.completed).toEqual({ ownerId: USER_ID, uploadId: UPLOAD_ID });
    expect(response.body.user.avatarUrl).toContain("avatar.webp");
  });

  it("removes the avatar reference", async () => {
    const service = new FakeAvatarService();
    const response = await request(createTestApp(service))
      .delete("/api/v1/users/me/avatar")
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(service.deletedFor).toBe(USER_ID);
    expect(response.body.user.avatarUrl).toBeNull();
  });

  it("shares the approved rate-limit bucket across create and complete", async () => {
    const service = new FakeAvatarService();
    const app = createTestApp(
      service,
      createHttpRateLimiter({
        identifier: "test-avatar-upload",
        windowMs: 60_000,
        limit: 1,
        scope: "user",
      }),
    );

    await request(app)
      .post("/api/v1/users/me/avatar/uploads")
      .set("Authorization", "Bearer token")
      .send({ contentType: "image/png", contentLength: 4 })
      .expect(201);
    const rejected = await request(app)
      .post(`/api/v1/users/me/avatar/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", "Bearer token")
      .expect(429);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
  });
});
