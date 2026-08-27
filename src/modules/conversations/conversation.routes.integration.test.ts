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
import {
  ConversationConflictError,
  ConversationNotFoundError,
  InsufficientRoleError,
  InvalidConversationOperationError,
} from "./conversation.errors.js";
import type {
  AddGroupMemberBody,
  CreateGroupConversationBody,
  ListConversationsQuery,
  TransferGroupOwnershipBody,
  UpdateGroupMemberRoleBody,
  UpdateGroupTitleBody,
} from "./conversation.schema.js";
import type {
  CreateDirectConversationResult,
  DirectConversationDto,
  GroupConversationDto,
  GroupMemberDto,
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

const groupMember: GroupMemberDto = {
  userId: BOB_ID,
  role: "MEMBER",
  joinedAt: NOW,
  user: conversation.otherUser,
};

const groupConversation: GroupConversationDto = {
  id: CONVERSATION_ID,
  type: "GROUP",
  title: "Core team",
  createdAt: NOW,
  members: [groupMember],
};

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: ALICE_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeConversationService implements ConversationHttpService {
  getError: unknown = null;
  mutationError: unknown = null;

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

  async createGroupConversation(
    _currentUserId: string,
    _input: CreateGroupConversationBody,
  ): Promise<GroupConversationDto> {
    this.throwMutationError();
    return groupConversation;
  }

  async updateGroupTitle(
    _currentUserId: string,
    _conversationId: string,
    _input: UpdateGroupTitleBody,
  ): Promise<GroupConversationDto> {
    this.throwMutationError();
    return groupConversation;
  }

  async addGroupMember(
    _currentUserId: string,
    _conversationId: string,
    _input: AddGroupMemberBody,
  ): Promise<GroupMemberDto> {
    this.throwMutationError();
    return groupMember;
  }

  async removeGroupMember(): Promise<void> {
    this.throwMutationError();
  }

  async leaveGroup(): Promise<void> {
    this.throwMutationError();
  }

  async updateGroupMemberRole(
    _currentUserId: string,
    _conversationId: string,
    _userId: string,
    _input: UpdateGroupMemberRoleBody,
  ): Promise<GroupMemberDto> {
    this.throwMutationError();
    return { ...groupMember, role: "ADMIN" };
  }

  async transferGroupOwnership(
    _currentUserId: string,
    _conversationId: string,
    _input: TransferGroupOwnershipBody,
  ): Promise<GroupConversationDto> {
    this.throwMutationError();
    return groupConversation;
  }

  private throwMutationError(): void {
    if (this.mutationError !== null) throw this.mutationError;
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

  it("requires authentication for group creation", async () => {
    const response = await request(createTestApp(new FakeConversationService()))
      .post("/api/v1/conversations/group")
      .send({ title: "Core team", userIds: [BOB_ID, CONVERSATION_ID] })
      .expect(401);

    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("creates a group with the approved body and returns its members", async () => {
    const response = await request(createTestApp(new FakeConversationService()))
      .post("/api/v1/conversations/group")
      .set("Authorization", "Bearer token")
      .send({ title: "Core team", userIds: [BOB_ID, CONVERSATION_ID] })
      .expect(201);

    expect(response.body).toMatchObject({
      id: CONVERSATION_ID,
      type: "GROUP",
      title: "Core team",
      members: [{ userId: BOB_ID, role: "MEMBER" }],
    });
  });

  it("routes every approved group mutation endpoint", async () => {
    const app = createTestApp(new FakeConversationService());
    const auth = { Authorization: "Bearer token" };

    await request(app).patch(`/api/v1/conversations/${CONVERSATION_ID}`).set(auth).send({ title: "Renamed" }).expect(200);
    await request(app).post(`/api/v1/conversations/${CONVERSATION_ID}/members`).set(auth).send({ userId: BOB_ID }).expect(201);
    await request(app).patch(`/api/v1/conversations/${CONVERSATION_ID}/members/${BOB_ID}`).set(auth).send({ role: "ADMIN" }).expect(200);
    await request(app).put(`/api/v1/conversations/${CONVERSATION_ID}/owner`).set(auth).send({ userId: BOB_ID }).expect(200);
    await request(app).delete(`/api/v1/conversations/${CONVERSATION_ID}/members/${BOB_ID}`).set(auth).expect(204);
    await request(app).delete(`/api/v1/conversations/${CONVERSATION_ID}/members/me`).set(auth).expect(204);
  });

  it("returns the exact 403 INSUFFICIENT_ROLE envelope", async () => {
    const service = new FakeConversationService();
    service.mutationError = new InsufficientRoleError();
    const response = await request(createTestApp(service))
      .patch(`/api/v1/conversations/${CONVERSATION_ID}`)
      .set("Authorization", "Bearer token")
      .send({ title: "Denied" })
      .expect(403);

    expect(response.body.error).toMatchObject({
      code: "INSUFFICIENT_ROLE",
      message: "Your role does not permit this action",
    });
    expect(response.body.error.requestId).toEqual(expect.any(String));
  });

  it("returns 409 CONFLICT for OWNER targeting and active-member conflicts", async () => {
    const service = new FakeConversationService();
    service.mutationError = new ConversationConflictError("Ownership must be transferred first");
    const response = await request(createTestApp(service))
      .delete(`/api/v1/conversations/${CONVERSATION_ID}/members/${BOB_ID}`)
      .set("Authorization", "Bearer token")
      .expect(409);

    expect(response.body.error).toMatchObject({
      code: "CONFLICT",
      message: "Ownership must be transferred first",
    });
  });

  it("returns 400 when the generic member-removal path targets the caller", async () => {
    const service = new FakeConversationService();
    service.mutationError = new InvalidConversationOperationError("Use /members/me to leave the group");
    const response = await request(createTestApp(service))
      .delete(`/api/v1/conversations/${CONVERSATION_ID}/members/${ALICE_ID}`)
      .set("Authorization", "Bearer token")
      .expect(400);

    expect(response.body.error).toMatchObject({
      code: "INVALID_OPERATION",
      message: "Use /members/me to leave the group",
    });
  });
});
