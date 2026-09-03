import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo } from "node:net";

import { Router } from "express";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import type { Server as SocketServer } from "socket.io";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { PrismaAuthRepository } from "../modules/auth/persistence/auth.repository.js";
import { AuthService } from "../modules/auth/application/auth.service.js";
import { AuthController } from "../modules/auth/http/auth.controller.js";
import {
  createAuthenticationMiddleware,
  createTrustedOriginMiddleware,
} from "../modules/auth/http/auth.middleware.js";
import { createAuthRouter } from "../modules/auth/http/auth.routes.js";
import { HttpRefreshCookieManager } from "../modules/auth/http/refresh-cookie.js";
import { PrismaAuthSessionRepository } from "../modules/auth/sessions/auth-session.repository.js";
import { AuthSessionService } from "../modules/auth/sessions/auth-session.service.js";
import { AccessTokenService } from "../modules/auth/tokens/access-token.service.js";
import { PrismaConversationRepository } from "../modules/conversations/conversation.repository.js";
import { ConversationService } from "../modules/conversations/conversation.service.js";
import { MessageController } from "../modules/messages/message.controller.js";
import { PrismaMessageRepository } from "../modules/messages/message.repository.js";
import { createMessageRouter } from "../modules/messages/message.routes.js";
import { MessageService } from "../modules/messages/message.service.js";
import { prisma } from "../infrastructure/database/prisma.js";
import type { Clock } from "../shared/time/clock.js";
import { SocketMessagePublisher } from "../realtime/messages/message-publisher.js";
import { SocketNotificationPublisher } from "../realtime/notifications/notification-publisher.js";
import type {
  PresenceLifecycleService,
  PresenceSnapshot,
} from "../realtime/presence/presence.service.js";
import type {
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ConversationSubscriptionAck,
} from "../realtime/server/chat-events.js";
import { createSocketServer } from "../realtime/server/create-socket-server.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CAROL_ID = "77777777-7777-4777-8777-777777777777";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const CLIENT_MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const JWT_SECRET = "contract-test-secret-with-at-least-32-bytes";

type ChatClientSocket = ClientSocket<
  ChatServerToClientEvents,
  ChatClientToServerEvents
>;

class MutableClock implements Clock {
  constructor(private current: Date = NOW) {}

  now(): Date {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class NoopPresenceService implements PresenceLifecycleService {
  async handleConnected(): Promise<void> {}
  async handleDisconnected(): Promise<void> {}
  async getSnapshot(): Promise<PresenceSnapshot> {
    return {};
  }
}

interface AuthRuntime {
  authService: AuthService;
  sessionService: AuthSessionService;
}

interface TestHarness {
  httpServer: HttpServer;
  url: string;
}

const clients: ChatClientSocket[] = [];
const servers: { http: HttpServer; socket: SocketServer }[] = [];

function createAuthRuntime(clock: Clock): AuthRuntime {
  const accessTokenService = new AccessTokenService(
    {
      secret: JWT_SECRET,
      issuer: "chat-api-contract-test",
      audience: "chat-web-contract-test",
      ttlMinutes: 1,
    },
    clock,
  );
  const sessionService = new AuthSessionService({
    sessionRepository: new PrismaAuthSessionRepository(prisma),
    accessTokenService,
    refreshTokenTtlDays: 30,
    clock,
  });
  const authService = new AuthService({
    authRepository: new PrismaAuthRepository(prisma),
    authSessionService: sessionService,
    accessTokenVerifier: accessTokenService,
    passwordService: {
      hashPassword: async () => "unused",
      verifyPassword: async () => false,
    },
    dummyPasswordHash: "unused",
  });

  return { authService, sessionService };
}

async function createHarness(
  runtime: AuthRuntime,
  clock: Clock,
): Promise<TestHarness> {
  const conversationService = new ConversationService(
    new PrismaConversationRepository(prisma),
  );
  const messagePublisher = new SocketMessagePublisher();
  const notificationPublisher = new SocketNotificationPublisher();
  const messageService = new MessageService(
    new PrismaMessageRepository(prisma),
    conversationService,
    messagePublisher,
    clock,
    undefined,
    notificationPublisher,
  );
  const authController = new AuthController({
    authService: runtime.authService,
    refreshCookieManager: new HttpRefreshCookieManager({
      secure: false,
      clock,
    }),
  });
  const apiRouter = Router();
  apiRouter.use(
    "/auth",
    createAuthRouter({
      controller: authController,
      authenticationMiddleware: createAuthenticationMiddleware(
        runtime.authService,
      ),
      trustedOriginMiddleware: createTrustedOriginMiddleware({
        trustedOrigin: "http://localhost:3000",
        enforce: false,
      }),
    }),
  );
  apiRouter.use(createAuthenticationMiddleware(runtime.authService));
  apiRouter.use(
    "/conversations/:conversationId/messages",
    createMessageRouter(new MessageController(messageService)),
  );

  const httpServer = createServer(createApp({ apiRouter }));
  const socketServer = createSocketServer(httpServer, {
    authenticator: runtime.authService,
    conversationAccessService: conversationService,
    presenceService: new NoopPresenceService(),
    messagePublisher,
    notificationPublisher,
    clock,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  servers.push({ http: httpServer, socket: socketServer });

  return { httpServer, url: `http://127.0.0.1:${address.port}` };
}

function newClient(url: string, token: string): ChatClientSocket {
  const client: ChatClientSocket = createClient(`${url}/chat`, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    autoConnect: false,
  });
  clients.push(client);
  return client;
}

function connectAndWaitForReady(client: ChatClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("session:ready", () => resolve());
    client.once("connect_error", reject);
    client.connect();
  });
}

function subscribe(
  client: ChatClientSocket,
): Promise<ConversationSubscriptionAck> {
  return new Promise((resolve) => {
    client.emit(
      "conversation:subscribe",
      { conversationId: CONVERSATION_ID },
      resolve,
    );
  });
}

async function seedConversation(): Promise<void> {
  await prisma.messageRead.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationMember.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.authSession.deleteMany();
  await prisma.user.deleteMany();

  await prisma.user.createMany({
    data: [
      {
        id: ALICE_ID,
        email: "alice.contract@example.com",
        username: "alice_contract",
        displayName: "Alice Contract",
        passwordHash: "unused",
      },
      {
        id: BOB_ID,
        email: "bob.contract@example.com",
        username: "bob_contract",
        displayName: "Bob Contract",
        passwordHash: "unused",
      },
      {
        id: CAROL_ID,
        email: "carol.contract@example.com",
        username: "carol_contract",
        displayName: "Carol Contract",
        passwordHash: "unused",
      },
    ],
  });
  await prisma.conversation.create({
    data: {
      id: CONVERSATION_ID,
      type: "DIRECT",
      directKey: `${ALICE_ID}:${BOB_ID}`,
      createdById: ALICE_ID,
      members: {
        create: [
          { userId: ALICE_ID, role: "MEMBER" },
          { userId: BOB_ID, role: "MEMBER" },
        ],
      },
    },
  });
}

beforeEach(seedConversation);

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }

  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.socket.close(() => resolve());
    });

    if (server.http.listening) {
      await new Promise<void>((resolve, reject) => {
        server.http.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  }
});

describe("backend behavior contracts against PostgreSQL", () => {
  it("requires a new conversation subscription after reconnect", async () => {
    const clock = new MutableClock();
    const runtime = createAuthRuntime(clock);
    const [aliceSession, bobSession] = await Promise.all([
      runtime.sessionService.createSession({ userId: ALICE_ID }),
      runtime.sessionService.createSession({ userId: BOB_ID }),
    ]);
    const { url } = await createHarness(runtime, clock);
    const bob = newClient(url, bobSession.accessToken);
    const firstAlice = newClient(url, aliceSession.accessToken);
    await Promise.all([
      connectAndWaitForReady(bob),
      connectAndWaitForReady(firstAlice),
    ]);
    await Promise.all([subscribe(bob), subscribe(firstAlice)]);
    firstAlice.close();

    const reconnectedAlice = newClient(url, aliceSession.accessToken);
    await connectAndWaitForReady(reconnectedAlice);
    let receivedBeforeResubscribe = false;
    bob.once("typing:updated", () => {
      receivedBeforeResubscribe = true;
    });
    reconnectedAlice.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(receivedBeforeResubscribe).toBe(false);
    await expect(subscribe(reconnectedAlice)).resolves.toEqual({ ok: true });
    const receivedAfterResubscribe = new Promise((resolve) => {
      bob.once("typing:updated", resolve);
    });
    reconnectedAlice.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    await expect(receivedAfterResubscribe).resolves.toMatchObject({
      conversationId: CONVERSATION_ID,
      userId: ALICE_ID,
      isTyping: true,
    });
  });

  it("keeps an established socket connected after access-token expiry and accepts a refreshed token on a new handshake", async () => {
    const clock = new MutableClock();
    const runtime = createAuthRuntime(clock);
    const aliceSession = await runtime.sessionService.createSession({
      userId: ALICE_ID,
    });
    const { httpServer, url } = await createHarness(runtime, clock);
    const established = newClient(url, aliceSession.accessToken);
    await connectAndWaitForReady(established);

    clock.advance(61_000);
    expect(established.connected).toBe(true);

    const expiredAttempt = newClient(url, aliceSession.accessToken);
    const expiredError = await new Promise<Error & { data?: unknown }>(
      (resolve) => {
        expiredAttempt.once("connect_error", resolve);
        expiredAttempt.connect();
      },
    );
    expect(expiredError.message).toBe("Authentication failed");
    expect(expiredError.data).toEqual({ code: "INVALID_TOKEN" });
    expect(established.connected).toBe(true);

    const refreshed = await request(httpServer)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `chat_refresh_token=${aliceSession.refreshToken}`)
      .expect(200);
    const refreshedClient = newClient(url, refreshed.body.accessToken);
    await expect(connectAndWaitForReady(refreshedClient)).resolves.toBeUndefined();
  });

  it("returns the original message with 200 and emits no second event for an idempotent retry", async () => {
    const clock = new MutableClock();
    const runtime = createAuthRuntime(clock);
    const [aliceSession, bobSession] = await Promise.all([
      runtime.sessionService.createSession({ userId: ALICE_ID }),
      runtime.sessionService.createSession({ userId: BOB_ID }),
    ]);
    const { httpServer, url } = await createHarness(runtime, clock);
    const bob = newClient(url, bobSession.accessToken);
    await connectAndWaitForReady(bob);
    await subscribe(bob);
    let eventCount = 0;
    let notificationEventCount = 0;
    let notificationPayload: unknown;
    bob.on("message:created", () => {
      eventCount += 1;
    });
    bob.on("notification:created", (payload) => {
      notificationEventCount += 1;
      notificationPayload = payload;
    });
    const body = {
      clientMessageId: CLIENT_MESSAGE_ID,
      content: { type: "text", text: "idempotent hello" },
    };

    const first = await request(httpServer)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .send(body)
      .expect(201);
    const retry = await request(httpServer)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .send(body)
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(retry.body).toEqual(first.body);
    expect(eventCount).toBe(1);
    expect(notificationEventCount).toBe(1);
    expect(notificationPayload).toMatchObject({
      type: "MESSAGE_CREATED",
      conversationId: CONVERSATION_ID,
      messageId: first.body.id,
    });
    await expect(prisma.message.count()).resolves.toBe(1);
    await expect(prisma.notification.count()).resolves.toBe(1);
  });

  it("edits and soft-deletes only for the sender while preserving a masked tombstone", async () => {
    const clock = new MutableClock();
    const runtime = createAuthRuntime(clock);
    const [aliceSession, bobSession, carolSession] = await Promise.all([
      runtime.sessionService.createSession({ userId: ALICE_ID }),
      runtime.sessionService.createSession({ userId: BOB_ID }),
      runtime.sessionService.createSession({ userId: CAROL_ID }),
    ]);
    const { httpServer, url } = await createHarness(runtime, clock);
    const alice = newClient(url, aliceSession.accessToken);
    const bob = newClient(url, bobSession.accessToken);
    await Promise.all([
      connectAndWaitForReady(alice),
      connectAndWaitForReady(bob),
    ]);
    await Promise.all([subscribe(alice), subscribe(bob)]);
    const collectionPath =
      `/api/v1/conversations/${CONVERSATION_ID}/messages`;
    const created = await request(httpServer)
      .post(collectionPath)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .send({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "original body" },
      })
      .expect(201);
    const messagePath = `${collectionPath}/${created.body.id}`;
    let updatedEventCount = 0;
    let deletedEventCount = 0;
    alice.on("message:updated", () => {
      updatedEventCount += 1;
    });
    bob.on("message:updated", () => {
      updatedEventCount += 1;
    });
    alice.on("message:deleted", () => {
      deletedEventCount += 1;
    });
    bob.on("message:deleted", () => {
      deletedEventCount += 1;
    });
    const aliceUpdateEvent = new Promise((resolve) => {
      alice.once("message:updated", resolve);
    });
    const bobUpdateEvent = new Promise((resolve) => {
      bob.once("message:updated", resolve);
    });

    const updatedResponse = await request(httpServer)
      .patch(messagePath)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .send({ content: { type: "text", text: "edited body" } })
      .expect(200);
    const [aliceUpdated, bobUpdated] = await Promise.all([
      aliceUpdateEvent,
      bobUpdateEvent,
    ]);

    expect(aliceUpdated).toEqual({ message: updatedResponse.body });
    expect(bobUpdated).toEqual({ message: updatedResponse.body });
    expect(updatedResponse.body).toMatchObject({
      body: "edited body",
      editedAt: NOW.toISOString(),
      deletedAt: null,
    });

    await request(httpServer)
      .patch(messagePath)
      .set("Authorization", `Bearer ${bobSession.accessToken}`)
      .send({ content: { type: "text", text: "bob cannot edit" } })
      .expect(404)
      .expect(({ body }) => {
        expect(body.error.code).toBe("MESSAGE_NOT_FOUND");
      });
    await request(httpServer)
      .delete(messagePath)
      .set("Authorization", `Bearer ${carolSession.accessToken}`)
      .expect(404)
      .expect(({ body }) => {
        expect(body.error.code).toBe("CONVERSATION_NOT_FOUND");
      });

    const aliceDeleteEvent = new Promise((resolve) => {
      alice.once("message:deleted", resolve);
    });
    const bobDeleteEvent = new Promise((resolve) => {
      bob.once("message:deleted", resolve);
    });
    const deletedResponse = await request(httpServer)
      .delete(messagePath)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .expect(200);
    const [aliceDeleted, bobDeleted] = await Promise.all([
      aliceDeleteEvent,
      bobDeleteEvent,
    ]);

    expect(aliceDeleted).toEqual({ message: deletedResponse.body });
    expect(bobDeleted).toEqual({ message: deletedResponse.body });
    expect(deletedResponse.body).toMatchObject({
      body: null,
      editedAt: NOW.toISOString(),
      deletedAt: NOW.toISOString(),
    });

    clock.advance(1_000);
    const repeatedDelete = await request(httpServer)
      .delete(messagePath)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .expect(200);
    const createRetry = await request(httpServer)
      .post(collectionPath)
      .set("Authorization", `Bearer ${aliceSession.accessToken}`)
      .send({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "must not revive" },
      })
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(repeatedDelete.body).toEqual(deletedResponse.body);
    expect(createRetry.body).toEqual(deletedResponse.body);
    expect(updatedEventCount).toBe(2);
    expect(deletedEventCount).toBe(2);

    const stored = await prisma.message.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(stored.body).toBe("edited body");
    expect(stored.editedAt).toEqual(NOW);
    expect(stored.deletedAt).toEqual(NOW);

    const history = await request(httpServer)
      .get(collectionPath)
      .set("Authorization", `Bearer ${bobSession.accessToken}`)
      .expect(200);
    expect(history.body.items).toEqual([deletedResponse.body]);

    const conversationService = new ConversationService(
      new PrismaConversationRepository(prisma),
    );
    const conversations = await conversationService.listConversations(
      BOB_ID,
      { limit: 20 },
    );
    expect(conversations.items[0]?.lastMessage).toMatchObject({
      id: created.body.id,
      body: null,
      deletedAt: NOW,
    });
    expect(conversations.items[0]?.unreadCount).toBe(0);
    await expect(prisma.notification.count()).resolves.toBe(1);
  });

  it("returns null cursors for empty and final pages and a base64url JSON cursor between pages", async () => {
    const clock = new MutableClock();
    const runtime = createAuthRuntime(clock);
    const aliceSession = await runtime.sessionService.createSession({
      userId: ALICE_ID,
    });
    const { httpServer } = await createHarness(runtime, clock);
    const path = `/api/v1/conversations/${CONVERSATION_ID}/messages`;
    const authorization = `Bearer ${aliceSession.accessToken}`;

    const empty = await request(httpServer)
      .get(path)
      .set("Authorization", authorization)
      .expect(200);
    expect(empty.body).toEqual({ items: [], nextCursor: null });

    await prisma.message.createMany({
      data: [1, 2, 3].map((index) => ({
        id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        conversationId: CONVERSATION_ID,
        senderId: ALICE_ID,
        clientMessageId: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        body: `page message ${index}`,
        createdAt: new Date(NOW.getTime() + index * 1_000),
      })),
    });

    const firstPage = await request(httpServer)
      .get(`${path}?limit=2`)
      .set("Authorization", authorization)
      .expect(200);
    expect(firstPage.body.items).toHaveLength(2);
    expect(firstPage.body.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
    const decoded: unknown = JSON.parse(
      Buffer.from(firstPage.body.nextCursor, "base64url").toString("utf8"),
    );
    expect(decoded).toMatchObject({ v: 1 });

    const finalPage = await request(httpServer)
      .get(`${path}?limit=2&before=${firstPage.body.nextCursor}`)
      .set("Authorization", authorization)
      .expect(200);
    expect(finalPage.body.items).toHaveLength(1);
    expect(finalPage.body.nextCursor).toBeNull();
  });

  it(
    "does not emit typing false automatically when the five-second expiry passes",
    async () => {
      const clock = new MutableClock();
      const runtime = createAuthRuntime(clock);
      const [aliceSession, bobSession] = await Promise.all([
        runtime.sessionService.createSession({ userId: ALICE_ID }),
        runtime.sessionService.createSession({ userId: BOB_ID }),
      ]);
      const { url } = await createHarness(runtime, clock);
      const alice = newClient(url, aliceSession.accessToken);
      const bob = newClient(url, bobSession.accessToken);
      await Promise.all([
        connectAndWaitForReady(alice),
        connectAndWaitForReady(bob),
      ]);
      await Promise.all([subscribe(alice), subscribe(bob)]);
      const received: Array<{ isTyping: boolean; expiresAt: string }> = [];
      bob.on("typing:updated", (event) => {
        received.push(event);
      });

      alice.emit("typing:set", {
        conversationId: CONVERSATION_ID,
        isTyping: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 5_100));

      expect(received).toEqual([
        expect.objectContaining({
          isTyping: true,
          expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
        }),
      ]);
    },
    8_000,
  );
});
