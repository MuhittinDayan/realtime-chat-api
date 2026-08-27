import { Router, type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { createHttpRateLimiter } from "../../http/middleware/rate-limit.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { MessageNotFoundError } from "./message.errors.js";
import { MessageController, type MessageHttpService } from "./message.controller.js";
import { createMessageRouter } from "./message.routes.js";
import type {
  CreateMessageBody,
  MessageHistoryQuery,
  UpdateMessageBody,
} from "./message.schema.js";
import type {
  CreateMessageResult,
  MessageDto,
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
  deletedAt: null,
};

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: ALICE_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeMessageService implements MessageHttpService {
  error: unknown = null;
  createInput: CreateMessageBody | null = null;
  updateInput: UpdateMessageBody | null = null;
  deletedMessageId: string | null = null;

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

  async updateMessage(
    _userId: string,
    _conversationId: string,
    _messageId: string,
    input: UpdateMessageBody,
  ): Promise<MessageDto> {
    if (this.error !== null) {
      throw this.error;
    }
    this.updateInput = input;
    return { ...message, body: input.content.text, editedAt: NOW };
  }

  async deleteMessage(
    _userId: string,
    _conversationId: string,
    messageId: string,
  ): Promise<MessageDto> {
    if (this.error !== null) {
      throw this.error;
    }
    this.deletedMessageId = messageId;
    return { ...message, body: null, deletedAt: NOW };
  }
}

const noRateLimit: RequestHandler = (_request, _response, next) => next();

function createTestApp(
  service: MessageHttpService,
  createRateLimitMiddleware: RequestHandler = noRateLimit,
) {
  const apiRouter = Router();
  apiRouter.use(
    createAuthenticationMiddleware(new FakeAuthenticator()),
  );
  apiRouter.use(
    "/conversations/:conversationId/messages",
    createMessageRouter(
      new MessageController(service),
      createRateLimitMiddleware,
    ),
  );
  return createApp({ apiRouter });
}

describe("message HTTP routes", () => {
  it("rate limits message creation per authenticated user", async () => {
    const app = createTestApp(
      new FakeMessageService(),
      createHttpRateLimiter({
        identifier: "test-message-create",
        windowMs: 60_000,
        limit: 1,
        scope: "user",
      }),
    );
    const payload = {
      clientMessageId: CLIENT_MESSAGE_ID,
      content: { type: "text", text: "hello" },
    };

    await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer token")
      .send(payload)
      .expect(201);
    const rejected = await request(app)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer token")
      .send(payload)
      .expect(429);

    expect(rejected.body.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(Number(rejected.headers["retry-after"])).toBeGreaterThan(0);
  });

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

  it("updates a message with trimmed text content", async () => {
    const service = new FakeMessageService();
    const response = await request(createTestApp(service))
      .patch(
        `/api/v1/conversations/${CONVERSATION_ID}/messages/${message.id}`,
      )
      .set("Authorization", "Bearer token")
      .send({ content: { type: "text", text: "  updated  " } })
      .expect(200);

    expect(service.updateInput?.content.text).toBe("updated");
    expect(response.body).toMatchObject({
      id: message.id,
      body: "updated",
      editedAt: NOW.toISOString(),
      deletedAt: null,
    });
  });

  it("rejects invalid update content before service access", async () => {
    const service = new FakeMessageService();
    const response = await request(createTestApp(service))
      .patch(
        `/api/v1/conversations/${CONVERSATION_ID}/messages/${message.id}`,
      )
      .set("Authorization", "Bearer token")
      .send({ content: { type: "text", text: "   " } })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.updateInput).toBeNull();
  });

  it("soft-deletes a message and returns its tombstone", async () => {
    const service = new FakeMessageService();
    const response = await request(createTestApp(service))
      .delete(
        `/api/v1/conversations/${CONVERSATION_ID}/messages/${message.id}`,
      )
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(service.deletedMessageId).toBe(message.id);
    expect(response.body).toMatchObject({
      id: message.id,
      body: null,
      deletedAt: NOW.toISOString(),
    });
  });

  it("returns generic message not found for an unauthorized mutation", async () => {
    const service = new FakeMessageService();
    service.error = new MessageNotFoundError();
    const response = await request(createTestApp(service))
      .delete(
        `/api/v1/conversations/${CONVERSATION_ID}/messages/${message.id}`,
      )
      .set("Authorization", "Bearer token")
      .expect(404);

    expect(response.body.error.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("rejects an invalid message UUID before service access", async () => {
    const service = new FakeMessageService();
    const response = await request(createTestApp(service))
      .delete(
        `/api/v1/conversations/${CONVERSATION_ID}/messages/not-a-uuid`,
      )
      .set("Authorization", "Bearer token")
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.deletedMessageId).toBeNull();
  });
});
