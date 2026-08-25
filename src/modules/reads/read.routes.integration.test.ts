import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { ReadController, type ReadHttpService } from "./read.controller.js";
import { createReadRouter } from "./read.routes.js";
import type { ReadWatermarkDto } from "./read.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: ALICE_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeReadService implements ReadHttpService {
  error: unknown = null;

  async updateWatermark(
    _userId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<ReadWatermarkDto> {
    if (this.error !== null) {
      throw this.error;
    }

    return {
      conversationId,
      throughMessageId,
      readAt: NOW,
      status: "created",
    };
  }
}

function createTestApp(service: ReadHttpService) {
  const apiRouter = Router();
  apiRouter.use(createAuthenticationMiddleware(new FakeAuthenticator()));
  apiRouter.use(
    "/conversations/:conversationId/read",
    createReadRouter(new ReadController(service)),
  );
  return createApp({ apiRouter });
}

describe("read watermark HTTP route", () => {
  it("updates the authenticated user's watermark", async () => {
    const response = await request(createTestApp(new FakeReadService()))
      .put(`/api/v1/conversations/${CONVERSATION_ID}/read`)
      .set("Authorization", "Bearer token")
      .send({ throughMessageId: MESSAGE_ID })
      .expect(200);

    expect(response.body).toEqual({
      conversationId: CONVERSATION_ID,
      throughMessageId: MESSAGE_ID,
      readAt: NOW.toISOString(),
      status: "created",
    });
  });

  it("rejects an invalid message UUID", async () => {
    const response = await request(createTestApp(new FakeReadService()))
      .put(`/api/v1/conversations/${CONVERSATION_ID}/read`)
      .set("Authorization", "Bearer token")
      .send({ throughMessageId: "invalid" })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("uses generic not-found for a non-member", async () => {
    const service = new FakeReadService();
    service.error = new ConversationNotFoundError();
    const response = await request(createTestApp(service))
      .put(`/api/v1/conversations/${CONVERSATION_ID}/read`)
      .set("Authorization", "Bearer token")
      .send({ throughMessageId: MESSAGE_ID })
      .expect(404);

    expect(response.body.error.code).toBe("CONVERSATION_NOT_FOUND");
  });
});
