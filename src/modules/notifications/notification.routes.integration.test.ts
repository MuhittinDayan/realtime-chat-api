import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/http/auth.middleware.js";
import {
  NotificationController,
  type NotificationHttpService,
} from "./notification.controller.js";
import { NotificationNotFoundError } from "./notification.errors.js";
import {
  createConversationNotificationRouter,
  createNotificationRouter,
} from "./notification.routes.js";
import type { ListNotificationsQuery } from "./notification.schema.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const NOTIFICATION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const dto = {
  id: NOTIFICATION_ID,
  type: "MESSAGE_CREATED" as const,
  conversationId: CONVERSATION_ID,
  createdAt: NOW,
  readAt: null,
  message: {
    id: "44444444-4444-4444-8444-444444444444",
    kind: "TEXT" as const,
    body: "hello",
    createdAt: NOW,
    editedAt: null,
    deletedAt: null,
    sender: {
      id: "55555555-5555-4555-8555-555555555555",
      username: "sender",
      displayName: "Sender",
      avatarUrl: null,
    },
  },
};

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: USER_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeNotificationService implements NotificationHttpService {
  markError: unknown = null;

  async listNotifications(
    _currentUserId: string,
    _input: ListNotificationsQuery,
  ) {
    return { items: [dto], nextCursor: null };
  }

  async getUnreadCount() {
    return { unreadCount: 1 };
  }

  async markRead() {
    if (this.markError !== null) throw this.markError;
    return { ...dto, readAt: NOW };
  }

  async markConversationRead() {
    return { markedCount: 2 };
  }
}

function createTestApp(service: FakeNotificationService) {
  const controller = new NotificationController(service);
  const apiRouter = Router();
  apiRouter.use(
    "/notifications",
    createNotificationRouter({
      controller,
      authenticationMiddleware: createAuthenticationMiddleware(
        new FakeAuthenticator(),
      ),
    }),
  );
  apiRouter.use(
    createAuthenticationMiddleware(new FakeAuthenticator()),
  );
  apiRouter.use(
    "/conversations/:conversationId/notifications",
    createConversationNotificationRouter(controller),
  );
  return createApp({ apiRouter });
}

describe("notification HTTP routes", () => {
  it("lists notifications and exposes a separate unread count", async () => {
    const app = createTestApp(new FakeNotificationService());
    const authorization = { Authorization: "Bearer token" };

    const list = await request(app)
      .get("/api/v1/notifications?limit=20")
      .set(authorization)
      .expect(200);
    const count = await request(app)
      .get("/api/v1/notifications/unread-count")
      .set(authorization)
      .expect(200);

    expect(list.body).toMatchObject({
      items: [{ id: NOTIFICATION_ID, type: "MESSAGE_CREATED" }],
      nextCursor: null,
    });
    expect(count.body).toEqual({ unreadCount: 1 });
  });

  it("marks one owned notification and hides missing ownership", async () => {
    const service = new FakeNotificationService();
    const app = createTestApp(service);

    await request(app)
      .patch(`/api/v1/notifications/${NOTIFICATION_ID}/read`)
      .set("Authorization", "Bearer token")
      .expect(200)
      .expect(({ body }) => {
        expect(body.readAt).toBe(NOW.toISOString());
      });

    service.markError = new NotificationNotFoundError();
    await request(app)
      .patch(`/api/v1/notifications/${NOTIFICATION_ID}/read`)
      .set("Authorization", "Bearer token")
      .expect(404)
      .expect(({ body }) => {
        expect(body.error.code).toBe("NOTIFICATION_NOT_FOUND");
      });
  });

  it("marks a conversation idempotently through the nested route", async () => {
    const app = createTestApp(new FakeNotificationService());
    await request(app)
      .patch(
        `/api/v1/conversations/${CONVERSATION_ID}/notifications/read`,
      )
      .set("Authorization", "Bearer token")
      .expect(200)
      .expect({ markedCount: 2 });
  });

  it("validates cursor, ids and authentication", async () => {
    const app = createTestApp(new FakeNotificationService());
    await request(app).get("/api/v1/notifications").expect(401);
    await request(app)
      .get("/api/v1/notifications?cursor=not-base64")
      .set("Authorization", "Bearer token")
      .expect(400);
    await request(app)
      .patch("/api/v1/notifications/not-a-uuid/read")
      .set("Authorization", "Bearer token")
      .expect(400);
  });
});
