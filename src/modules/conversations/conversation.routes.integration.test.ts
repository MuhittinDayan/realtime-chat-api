import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../auth/auth.middleware.js";
import {
  ConversationController,
  type ConversationHttpService,
} from "./conversation.controller.js";
import { ConversationNotFoundError } from "./conversation.errors.js";
import type { ListConversationsQuery } from "./conversation.schema.js";
import type {
  CreateDirectConversationResult,
  DirectConversationDto,
  ListConversationsResult,
} from "./conversation.service.js";
import { createConversationRouter } from "./conversation.routes.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");

const conversation: DirectConversationDto = {
  id: CONVERSATION_ID,
  type: "DIRECT",
  title: null,
  createdAt: NOW,
  otherUser: {
    id: BOB_ID,
    username: "bob",
    displayName: "Bob",
    avatarUrl: null,
  },
};

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: ALICE_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeConversationService implements ConversationHttpService {
  getError: unknown = null;

  async getOrCreateDirectConversation(
    _currentUserId: string,
    _targetUserId: string,
  ): Promise<CreateDirectConversationResult> {
    return { conversation, created: true };
  }

  async listConversations(
    _currentUserId: string,
    _input: ListConversationsQuery,
  ): Promise<ListConversationsResult> {
    return {
      items: [
        {
          ...conversation,
          lastMessageAt: NOW,
          lastMessage: {
            id: "55555555-5555-4555-8555-555555555555",
            body: "hello",
            senderId: BOB_ID,
            createdAt: NOW,
            deletedAt: null,
          },
          unreadCount: 3,
        },
      ],
      nextCursor: null,
    };
  }

  async getConversation(): Promise<DirectConversationDto> {
    if (this.getError !== null) {
      throw this.getError;
    }
    return conversation;
  }
}

function createTestApp(service: ConversationHttpService) {
  const apiRouter = Router();
  apiRouter.use(
    "/conversations",
    createConversationRouter({
      controller: new ConversationController(service),
      authenticationMiddleware: createAuthenticationMiddleware(
        new FakeAuthenticator(),
      ),
    }),
  );
  return createApp({ apiRouter });
}

describe("conversation HTTP routes", () => {
  it("creates a conversation without exposing directKey", async () => {
    const response = await request(
      createTestApp(new FakeConversationService()),
    )
      .post("/api/v1/conversations/direct")
      .set("Authorization", "Bearer token")
      .send({ userId: BOB_ID })
      .expect(201);

    expect(response.body.id).toBe(CONVERSATION_ID);
    expect(response.body).not.toHaveProperty("directKey");
    expect(response.body).not.toHaveProperty("createdById");
  });

  it("allows a member to fetch a conversation", async () => {
    const response = await request(
      createTestApp(new FakeConversationService()),
    )
      .get(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(response.body.otherUser.id).toBe(BOB_ID);
  });

  it("returns lastMessage and unreadCount in the conversation list", async () => {
    const response = await request(
      createTestApp(new FakeConversationService()),
    )
      .get("/api/v1/conversations")
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(response.body.items[0].lastMessage).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      body: "hello",
      senderId: BOB_ID,
      createdAt: NOW.toISOString(),
      deletedAt: null,
    });
    expect(response.body.items[0].unreadCount).toBe(3);
  });

  it("uses a generic not-found response for non-members", async () => {
    const service = new FakeConversationService();
    service.getError = new ConversationNotFoundError();
    const response = await request(createTestApp(service))
      .get(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set("Authorization", "Bearer token")
      .expect(404);

    expect(response.body.error.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("rejects an invalid conversation UUID before service access", async () => {
    const response = await request(
      createTestApp(new FakeConversationService()),
    )
      .get("/api/v1/conversations/not-a-uuid")
      .set("Authorization", "Bearer token")
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
