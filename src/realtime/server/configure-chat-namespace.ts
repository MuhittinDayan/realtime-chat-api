import type { Namespace } from "socket.io";
import { z } from "zod";

import type { AccessAuthenticator } from "../../modules/auth/auth.middleware.js";
import type { ConversationAccessService } from "../../modules/messages/message.service.js";
import type { Clock } from "../../shared/time/clock.js";
import { createSocketAuthenticationMiddleware } from "../auth/socket-auth.middleware.js";
import type { PresenceLifecycleService } from "../presence/presence.service.js";
import {
  SocketEventRateLimiter,
  type SocketEventRateLimitPolicy,
  typingRateLimitPolicy,
} from "../rate-limit/socket-event-rate-limiter.js";
import {
  conversationRoom,
  sessionRoom,
  userRoom,
} from "../rooms/room-names.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
  ConversationSubscriptionAck,
  PresenceSubscriptionAck,
} from "./chat-events.js";

type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

const conversationEventSchema = z
  .object({ conversationId: z.string().uuid() })
  .strict();

const typingEventSchema = z
  .object({
    conversationId: z.string().uuid(),
    isTyping: z.boolean(),
  })
  .strict();

const presenceSubscriptionSchema = z
  .object({ userIds: z.array(z.string().uuid()).max(100) })
  .strict();

export interface ConfigureChatNamespaceOptions {
  authenticator: AccessAuthenticator;
  conversationAccessService: ConversationAccessService;
  presenceService: PresenceLifecycleService;
  clock: Clock;
  typingRateLimitPolicy?: SocketEventRateLimitPolicy;
}

export function configureChatNamespace(
  namespace: ChatNamespace,
  options: ConfigureChatNamespaceOptions,
): void {
  namespace.use(createSocketAuthenticationMiddleware(options.authenticator));

  namespace.on("connection", (socket) => {
    const { userId, sessionId } = socket.data;
    const typingRateLimiter = new SocketEventRateLimiter(
      options.typingRateLimitPolicy ?? typingRateLimitPolicy,
    );
    const connected = options.presenceService.handleConnected(
      userId,
      socket.id,
    );
    void connected.catch(() => undefined);

    socket.on("disconnect", () => {
      void options.presenceService
        .handleDisconnected(userId, socket.id)
        .catch(() => undefined);
    });

    socket.on("conversation:subscribe", async (payload, acknowledge) => {
      if (typeof acknowledge !== "function") {
        return;
      }

      const parsed = conversationEventSchema.safeParse(payload);

      if (!parsed.success) {
        acknowledge(validationFailure());
        return;
      }

      let isMember: boolean;

      try {
        isMember = await options.conversationAccessService.isActiveMember(
          parsed.data.conversationId,
          userId,
        );
      } catch {
        acknowledge({ ok: false, error: { code: "FORBIDDEN" } });
        return;
      }

      if (!isMember) {
        acknowledge({ ok: false, error: { code: "FORBIDDEN" } });
        return;
      }

      await socket.join(conversationRoom(parsed.data.conversationId));
      acknowledge({ ok: true });
    });

    socket.on("conversation:unsubscribe", async (payload, acknowledge) => {
      if (typeof acknowledge !== "function") {
        return;
      }

      const parsed = conversationEventSchema.safeParse(payload);

      if (!parsed.success) {
        acknowledge(validationFailure());
        return;
      }

      await socket.leave(conversationRoom(parsed.data.conversationId));
      acknowledge({ ok: true });
    });

    socket.on("typing:set", (payload) => {
      const now = options.clock.now();

      if (!typingRateLimiter.tryAcquire(now)) {
        return;
      }

      const parsed = typingEventSchema.safeParse(payload);

      if (!parsed.success) {
        return;
      }

      const room = conversationRoom(parsed.data.conversationId);

      if (!socket.rooms.has(room)) {
        return;
      }

      socket.to(room).volatile.emit("typing:updated", {
        conversationId: parsed.data.conversationId,
        userId,
        isTyping: parsed.data.isTyping,
        expiresAt: new Date(now.getTime() + 5_000).toISOString(),
      });
    });

    socket.on("presence:subscribe", async (payload, acknowledge) => {
      if (typeof acknowledge !== "function") {
        return;
      }

      const parsed = presenceSubscriptionSchema.safeParse(payload);

      if (!parsed.success) {
        acknowledge(presenceValidationFailure());
        return;
      }

      const snapshot = await options.presenceService.getSnapshot(
        userId,
        [...new Set(parsed.data.userIds)],
      );
      acknowledge({ ok: true, data: snapshot });
    });

    void Promise.resolve(
      socket.join([userRoom(userId), sessionRoom(sessionId)]),
    ).then(() => {
      socket.emit("session:ready", {
        userId,
        socketId: socket.id,
        serverTime: options.clock.now().toISOString(),
      });
    });
  });
}

function validationFailure(): ConversationSubscriptionAck {
  return { ok: false, error: { code: "VALIDATION_ERROR" } };
}

function presenceValidationFailure(): PresenceSubscriptionAck {
  return { ok: false, error: { code: "VALIDATION_ERROR" } };
}
