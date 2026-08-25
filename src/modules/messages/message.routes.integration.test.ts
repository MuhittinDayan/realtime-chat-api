import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { MessageController, type MessageHttpService } from "./message.controller.js";
import { createMessageRouter } from "./message.routes.js";
import type {
  CreateMessageBody,
  MessageHistoryQuery,
} from "./message.schema.js";
import type {
  CreateMessageResult,
  MessageHistoryResult,
} from "./message.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const message = {
  id: "44444444-4444-4444-8444-444444444444",
  conversationId: CONVERSATION_ID,
  senderId: ALICE_ID,
  clientMessageId: CLIENT_MESSAGE_ID,
  kind: "TEXT" as const,
  body: "hello",
  createdAt: NOW,
  editedAt: null,
};

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: ALICE_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeMessageService implements MessageHttpService {
  error: unknown = null;
  createInput: CreateMessageBody | null = null;

  async createMessage(
    _userId: string,
    _conversationId: string,
    input: CreateMessageBody,
  ): Promise<CreateMessageResult> {
    if (this.error !== null) {
      throw this.error;
    }
    this.createInput = input;
    return { message: { ...message, body: input.content.text }, created: true };
  }

  async listMessages(
    _userId: string,
    _conversationId: string,
    _input: MessageHistoryQuery,
  ): Promise<MessageHistoryResult> {
    if (this.error !== null) {
      throw this.error;
    }
    return { items: [message], nextCursor: null };
  }
}

function createTestApp(service: MessageHttpService) {
  const apiRouter = Router();
  apiRouter.use(
    createAuthenticationMiddleware(new FakeAuthenticator()),
  );
  apiRouter.use(
    "/conversations/:conversationId/messages",
    createMessageRouter(new MessageController(service)),
  );
  return createApp({ apiRouter });
}

describe("message HTTP routes", () => {
  it("creates a trimmed text message", async () => {
    const service = new FakeMessageService();
    const response = await request(createTestApp(service))
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer token")
      .send({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "  hello  " },
      })
      .expect(201);

    expect(service.createInput?.content.text).toBe("hello");
    expect(response.body.body).toBe("hello");
  });

  it.each(["   ", "x".repeat(4_001)])(
    "rejects invalid text content",
    async (text) => {
      const service = new FakeMessageService();
      const response = await request(createTestApp(service))
        .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
        .set("Authorization", "Bearer token")
        .send({
          clientMessageId: CLIENT_MESSAGE_ID,
          content: { type: "text", text },
        })
        .expect(400);

      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(service.createInput).toBeNull();
    },
  );

  it("returns generic conversation not found to a non-member", async () => {
    const service = new FakeMessageService();
    service.error = new ConversationNotFoundError();
    const response = await request(createTestApp(service))
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer token")
      .send({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "hello" },
      })
      .expect(404);

    expect(response.body.error.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("returns message history", async () => {
    const response = await request(
      createTestApp(new FakeMessageService()),
    )
      .get(`/api/v1/conversations/${CONVERSATION_ID}/messages?limit=25`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(response.body.items[0].id).toBe(message.id);
    expect(response.body.nextCursor).toBeNull();
  });

  it("prevents a non-member from reading history", async () => {
    const service = new FakeMessageService();
    service.error = new ConversationNotFoundError();
    const response = await request(createTestApp(service))
      .get(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer token")
      .expect(404);

    expect(response.body.error.code).toBe("CONVERSATION_NOT_FOUND");
  });
});
