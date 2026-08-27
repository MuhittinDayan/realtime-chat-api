import { type AddressInfo } from "node:net";
import { createServer, type Server as HttpServer } from "node:http";

import { Router } from "express";
import request from "supertest";
import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import type { Server as SocketServer } from "socket.io";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { InvalidTokenError } from "../../modules/auth/auth.errors.js";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../../modules/auth/auth.middleware.js";
import { MessageController } from "../../modules/messages/message.controller.js";
import type {
  CreateMessageRepositoryInput,
  CreateMessageRepositoryResult,
  ListMessagesRepositoryInput,
  MessageMutationRepositoryResult,
  MessageRecord,
  MessageRepository,
  SoftDeleteMessageRepositoryInput,
  UpdateMessageRepositoryInput,
} from "../../modules/messages/message.repository.js";
import { createMessageRouter } from "../../modules/messages/message.routes.js";
import {
  MessageService,
  type ConversationAccessService,
} from "../../modules/messages/message.service.js";
import type { Clock } from "../../shared/time/clock.js";
import { SocketMessagePublisher } from "../messages/message-publisher.js";
import { SocketGroupPublisher } from "../groups/group-publisher.js";
import { ConnectionRegistry } from "../presence/connection-registry.js";
import { SocketPresencePublisher } from "../presence/presence-publisher.js";
import type { SocketEventRateLimitPolicy } from "../rate-limit/socket-event-rate-limiter.js";
import type {
  PresenceRepository,
  PresenceUserRecord,
} from "../presence/presence.repository.js";
import type {
  PresenceLifecycleService,
  PresenceSnapshot,
} from "../presence/presence.service.js";
import { PresenceService } from "../presence/presence.service.js";
import type {
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ConversationSubscriptionAck,
  MessageEventDto,
  PresenceSubscriptionAck,
} from "./chat-events.js";
import { createSocketServer } from "./create-socket-server.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CAROL_ID = "33333333-3333-4333-8333-333333333333";
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const CLIENT_MESSAGE_ID = "55555555-5555-4555-8555-555555555555";
const MESSAGE_ID = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2030-01-01T00:00:00.000Z");

type ChatClientSocket = ClientSocket<
  ChatServerToClientEvents,
  ChatClientToServerEvents
>;

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken(token: string) {
    const users: Record<string, string> = {
      "valid-alice": ALICE_ID,
      "valid-bob": BOB_ID,
      "valid-carol": CAROL_ID,
    };
    const userId = users[token];

    if (userId === undefined) {
      throw new InvalidTokenError();
    }

    return { userId, sessionId: `session-${userId}`, jwtId: "jwt" };
  }
}

class FakeConversationAccess implements ConversationAccessService {
  calls = 0;

  async isActiveMember(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    this.calls += 1;
    return (
      conversationId === CONVERSATION_ID &&
      (userId === ALICE_ID || userId === BOB_ID)
    );
  }
}

class NoopPresenceService implements PresenceLifecycleService {
  async handleConnected(): Promise<void> {}
  async handleDisconnected(): Promise<void> {}
  async getSnapshot(): Promise<PresenceSnapshot> {
    return {};
  }
}

class InMemoryPresenceRepository implements PresenceRepository {
  readonly lastSeenByUser = new Map<string, Date | null>();
  updateCount = 0;
  requestedUserIds: readonly string[] = [];

  async findDirectPeerIds(userId: string): Promise<readonly string[]> {
    if (userId === ALICE_ID) {
      return [BOB_ID];
    }
    if (userId === BOB_ID) {
      return [ALICE_ID];
    }
    return [];
  }

  async findAuthorizedUsers(
    requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<readonly PresenceUserRecord[]> {
    this.requestedUserIds = requestedUserIds;
    const authorized =
      requesterId === ALICE_ID
        ? new Set([BOB_ID])
        : requesterId === BOB_ID
          ? new Set([ALICE_ID])
          : new Set<string>();

    return requestedUserIds
      .filter((userId) => authorized.has(userId))
      .map((userId) => ({
        id: userId,
        lastSeenAt: this.lastSeenByUser.get(userId) ?? null,
      }));
  }

  async updateLastSeen(
    userId: string,
    lastSeenAt: Date,
  ): Promise<Date> {
    this.updateCount += 1;
    this.lastSeenByUser.set(userId, lastSeenAt);
    return lastSeenAt;
  }
}

class InMemoryMessageRepository implements MessageRepository {
  private message: MessageRecord | null = null;

  async createMessage(
    input: CreateMessageRepositoryInput,
  ): Promise<CreateMessageRepositoryResult> {
    if (
      this.message !== null &&
      this.message.senderId === input.senderId &&
      this.message.clientMessageId === input.clientMessageId
    ) {
      return { message: this.message, created: false };
    }

    const created: MessageRecord = {
      id: MESSAGE_ID,
      conversationId: input.conversationId,
      senderId: input.senderId,
      clientMessageId: input.clientMessageId,
      kind: "TEXT",
      body: input.body,
      createdAt: NOW,
      editedAt: null,
      deletedAt: null,
    };
    this.message = created;
    return { message: created, created: true };
  }

  async listMessages(
    _input: ListMessagesRepositoryInput,
  ): Promise<readonly MessageRecord[]> {
    return this.message === null ? [] : [this.message];
  }

  async updateMessage(
    input: UpdateMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    if (
      this.message === null ||
      this.message.id !== input.messageId ||
      this.message.conversationId !== input.conversationId ||
      this.message.senderId !== input.senderId ||
      this.message.deletedAt !== null
    ) {
      return { message: null, changed: false };
    }

    if (this.message.body === input.body) {
      return { message: this.message, changed: false };
    }

    this.message.body = input.body;
    this.message.editedAt = input.editedAt;
    return { message: this.message, changed: true };
  }

  async softDeleteMessage(
    input: SoftDeleteMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    if (
      this.message === null ||
      this.message.id !== input.messageId ||
      this.message.conversationId !== input.conversationId ||
      this.message.senderId !== input.senderId
    ) {
      return { message: null, changed: false };
    }

    if (this.message.deletedAt !== null) {
      return { message: this.message, changed: false };
    }

    this.message.deletedAt = input.deletedAt;
    return { message: this.message, changed: true };
  }
}

const fixedClock: Clock = { now: () => NOW };
const clients: ChatClientSocket[] = [];
const servers: { http: HttpServer; socket: SocketServer }[] = [];

interface HarnessPresenceOptions {
  service: PresenceLifecycleService;
  publisher: SocketPresencePublisher;
}

async function createHarness(
  presence?: HarnessPresenceOptions,
  typingLimit?: SocketEventRateLimitPolicy,
): Promise<{
  httpServer: HttpServer;
  socketServer: SocketServer;
  url: string;
  access: FakeConversationAccess;
  groupPublisher: SocketGroupPublisher;
}> {
  const authenticator = new FakeAuthenticator();
  const access = new FakeConversationAccess();
  const publisher = new SocketMessagePublisher();
  const groupPublisher = new SocketGroupPublisher();
  const messageService = new MessageService(
    new InMemoryMessageRepository(),
    access,
    publisher,
    fixedClock,
  );
  const apiRouter = Router();
  apiRouter.use(createAuthenticationMiddleware(authenticator));
  apiRouter.use(
    "/conversations/:conversationId/messages",
    createMessageRouter(new MessageController(messageService)),
  );
  const httpServer = createServer(createApp({ apiRouter }));
  const socketServer = createSocketServer(httpServer, {
    authenticator,
    conversationAccessService: access,
    presenceService: presence?.service ?? new NoopPresenceService(),
    ...(presence === undefined
      ? {}
      : { presencePublisher: presence.publisher }),
    messagePublisher: publisher,
    groupPublisher,
    clock: fixedClock,
    ...(typingLimit === undefined
      ? {}
      : { typingRateLimitPolicy: typingLimit }),
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address() as AddressInfo;
  servers.push({ http: httpServer, socket: socketServer });
  return {
    httpServer,
    socketServer,
    url: `http://127.0.0.1:${address.port}`,
    access,
    groupPublisher,
  };
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

function connectAndWaitForReady(client: ChatClientSocket): Promise<{
  userId: string;
  socketId: string;
  serverTime: string;
}> {
  return new Promise((resolve, reject) => {
    client.once("session:ready", resolve);
    client.once("connect_error", reject);
    client.connect();
  });
}

function subscribe(
  client: ChatClientSocket,
  conversationId = CONVERSATION_ID,
): Promise<ConversationSubscriptionAck> {
  return new Promise((resolve) => {
    client.emit("conversation:subscribe", { conversationId }, resolve);
  });
}

function unsubscribe(
  client: ChatClientSocket,
  conversationId = CONVERSATION_ID,
): Promise<ConversationSubscriptionAck> {
  return new Promise((resolve) => {
    client.emit("conversation:unsubscribe", { conversationId }, resolve);
  });
}

function presenceSnapshot(
  client: ChatClientSocket,
  userIds: string[],
): Promise<PresenceSubscriptionAck> {
  return new Promise((resolve) => {
    client.emit("presence:subscribe", { userIds }, resolve);
  });
}

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

describe("/chat Socket.IO integration", () => {
  it("rejects an invalid access token", async () => {
    const { url } = await createHarness();
    const client = newClient(url, "invalid");
    const error = await new Promise<Error>((resolve) => {
      client.once("connect_error", resolve);
      client.connect();
    });

    expect(error.message).toBe("Authentication failed");
  });

  it("authenticates and sends session:ready", async () => {
    const { url } = await createHarness();
    const client = newClient(url, "valid-alice");

    const ready = await connectAndWaitForReady(client);

    expect(ready.userId).toBe(ALICE_ID);
    expect(ready.socketId).toBe(client.id);
    expect(new Date(ready.serverTime).toISOString()).toBe(NOW.toISOString());
  });

  it("allows a member to subscribe", async () => {
    const { url } = await createHarness();
    const client = newClient(url, "valid-bob");
    await connectAndWaitForReady(client);

    await expect(subscribe(client)).resolves.toEqual({ ok: true });
    await expect(unsubscribe(client)).resolves.toEqual({ ok: true });
  });

  it("rejects a non-member subscription with FORBIDDEN", async () => {
    const { url } = await createHarness();
    const client = newClient(url, "valid-carol");
    await connectAndWaitForReady(client);

    await expect(subscribe(client)).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
  });

  it("forces every active socket of a removed member out of the conversation room", async () => {
    const { url, socketServer, groupPublisher } = await createHarness();
    const firstBobClient = newClient(url, "valid-bob");
    const secondBobClient = newClient(url, "valid-bob");
    await Promise.all([
      connectAndWaitForReady(firstBobClient),
      connectAndWaitForReady(secondBobClient),
    ]);
    await Promise.all([subscribe(firstBobClient), subscribe(secondBobClient)]);
    const room = `conversation:${CONVERSATION_ID}`;
    const firstSocketId = firstBobClient.id;
    const secondSocketId = secondBobClient.id;
    if (firstSocketId === undefined || secondSocketId === undefined) {
      throw new Error("Expected connected socket ids");
    }
    expect(socketServer.of("/chat").sockets.get(firstSocketId)?.rooms.has(room)).toBe(true);
    expect(socketServer.of("/chat").sockets.get(secondSocketId)?.rooms.has(room)).toBe(true);

    groupPublisher.publishMemberRemoved(CONVERSATION_ID, BOB_ID);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(socketServer.of("/chat").sockets.get(firstSocketId)?.rooms.has(room)).toBe(false);
    expect(socketServer.of("/chat").sockets.get(secondSocketId)?.rooms.has(room)).toBe(false);
  });

  it("broadcasts a REST-created message only to subscribed clients", async () => {
    const { httpServer, url } = await createHarness();
    const subscribedBob = newClient(url, "valid-bob");
    const unsubscribedAlice = newClient(url, "valid-alice");
    await Promise.all([
      connectAndWaitForReady(subscribedBob),
      connectAndWaitForReady(unsubscribedAlice),
    ]);
    await subscribe(subscribedBob);
    let leakedToUnsubscribedClient = false;
    unsubscribedAlice.on("message:created", () => {
      leakedToUnsubscribedClient = true;
    });
    const receivedBySubscriber = new Promise<{
      message: MessageEventDto;
    }>((resolve) => {
      subscribedBob.once("message:created", resolve);
    });

    const responsePromise = request(httpServer)
      .post(`/api/v1/conversations/${CONVERSATION_ID}/messages`)
      .set("Authorization", "Bearer valid-alice")
      .send({
        clientMessageId: CLIENT_MESSAGE_ID,
        content: { type: "text", text: "hello over realtime" },
      })
      .expect(201);
    const [event] = await Promise.all([
      receivedBySubscriber,
      responsePromise,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(event.message.id).toBe(MESSAGE_ID);
    expect(event.message.body).toBe("hello over realtime");
    expect(leakedToUnsubscribedClient).toBe(false);
  });

  it("broadcasts typing only from a subscribed socket to other subscribers", async () => {
    const { url, access } = await createHarness();
    const aliceClient = newClient(url, "valid-alice");
    const bobClient = newClient(url, "valid-bob");
    await Promise.all([
      connectAndWaitForReady(aliceClient),
      connectAndWaitForReady(bobClient),
    ]);
    await Promise.all([subscribe(aliceClient), subscribe(bobClient)]);
    const accessCallsBeforeTyping = access.calls;
    let echoedToSender = false;
    aliceClient.on("typing:updated", () => {
      echoedToSender = true;
    });
    const received = new Promise<{
      conversationId: string;
      userId: string;
      isTyping: boolean;
      expiresAt: string;
    }>((resolve) => {
      bobClient.once("typing:updated", resolve);
    });

    aliceClient.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    const event = await received;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(event).toEqual({
      conversationId: CONVERSATION_ID,
      userId: ALICE_ID,
      isTyping: true,
      expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
    });
    expect(echoedToSender).toBe(false);
    expect(access.calls).toBe(accessCallsBeforeTyping);
  });

  it("silently ignores typing from an unsubscribed socket", async () => {
    const { url } = await createHarness();
    const aliceClient = newClient(url, "valid-alice");
    const bobClient = newClient(url, "valid-bob");
    await Promise.all([
      connectAndWaitForReady(aliceClient),
      connectAndWaitForReady(bobClient),
    ]);
    await subscribe(bobClient);
    let received = false;
    bobClient.on("typing:updated", () => {
      received = true;
    });

    aliceClient.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toBe(false);
  });

  it("silently drops typing events above the per-socket flood limit", async () => {
    const { url } = await createHarness(undefined, {
      windowMs: 5_000,
      limit: 1,
    });
    const aliceClient = newClient(url, "valid-alice");
    const bobClient = newClient(url, "valid-bob");
    await Promise.all([
      connectAndWaitForReady(aliceClient),
      connectAndWaitForReady(bobClient),
    ]);
    await Promise.all([subscribe(aliceClient), subscribe(bobClient)]);
    let receivedCount = 0;
    const receivedAllowedEvent = new Promise<void>((resolve) => {
      bobClient.on("typing:updated", () => {
        receivedCount += 1;
        resolve();
      });
    });

    aliceClient.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    await receivedAllowedEvent;
    aliceClient.emit("typing:set", {
      conversationId: CONVERSATION_ID,
      isTyping: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedCount).toBe(1);
  });

  it("publishes presence transitions only to direct peers", async () => {
    const repository = new InMemoryPresenceRepository();
    const publisher = new SocketPresencePublisher();
    const service = new PresenceService(
      new ConnectionRegistry(),
      repository,
      publisher,
      fixedClock,
    );
    const { url } = await createHarness({ service, publisher });
    const bobClient = newClient(url, "valid-bob");
    const carolClient = newClient(url, "valid-carol");
    await Promise.all([
      connectAndWaitForReady(bobClient),
      connectAndWaitForReady(carolClient),
    ]);
    let unrelatedEventCount = 0;
    carolClient.on("presence:updated", () => {
      unrelatedEventCount += 1;
    });
    const onlineEvent = new Promise<{
      userId: string;
      status: "online" | "offline";
      lastSeenAt: string | null;
    }>((resolve) => {
      bobClient.once("presence:updated", resolve);
    });
    const firstAliceClient = newClient(url, "valid-alice");
    await connectAndWaitForReady(firstAliceClient);

    await expect(onlineEvent).resolves.toEqual({
      userId: ALICE_ID,
      status: "online",
      lastSeenAt: null,
    });

    let additionalBobEvents = 0;
    bobClient.on("presence:updated", () => {
      additionalBobEvents += 1;
    });
    const secondAliceClient = newClient(url, "valid-alice");
    await connectAndWaitForReady(secondAliceClient);
    firstAliceClient.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(repository.updateCount).toBe(0);
    expect(additionalBobEvents).toBe(0);

    const offlineEvent = new Promise<{
      userId: string;
      status: "online" | "offline";
      lastSeenAt: string | null;
    }>((resolve) => {
      bobClient.once("presence:updated", resolve);
    });
    secondAliceClient.close();

    await expect(offlineEvent).resolves.toEqual({
      userId: ALICE_ID,
      status: "offline",
      lastSeenAt: NOW.toISOString(),
    });
    expect(repository.updateCount).toBe(1);
    expect(unrelatedEventCount).toBe(0);
  });

  it("returns authorized presence snapshots and validates request limits", async () => {
    const repository = new InMemoryPresenceRepository();
    const publisher = new SocketPresencePublisher();
    const service = new PresenceService(
      new ConnectionRegistry(),
      repository,
      publisher,
      fixedClock,
    );
    const { url } = await createHarness({ service, publisher });
    const aliceClient = newClient(url, "valid-alice");
    const bobClient = newClient(url, "valid-bob");
    await Promise.all([
      connectAndWaitForReady(aliceClient),
      connectAndWaitForReady(bobClient),
    ]);

    await expect(
      presenceSnapshot(aliceClient, [BOB_ID, BOB_ID, CAROL_ID]),
    ).resolves.toEqual({
      ok: true,
      data: {
        [BOB_ID]: { status: "online", lastSeenAt: null },
      },
    });
    expect(repository.requestedUserIds).toEqual([BOB_ID, CAROL_ID]);
    await expect(
      presenceSnapshot(aliceClient, ["invalid"]),
    ).resolves.toEqual({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    await expect(
      presenceSnapshot(aliceClient, Array(101).fill(BOB_ID)),
    ).resolves.toEqual({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });
});
