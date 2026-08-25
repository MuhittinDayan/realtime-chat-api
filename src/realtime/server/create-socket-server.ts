import type { Server as HttpServer } from "node:http";

import { Server as SocketIoServer } from "socket.io";

import { env } from "../../config/env.js";
import { authService } from "../../modules/auth/auth-core.js";
import type { AccessAuthenticator } from "../../modules/auth/auth.middleware.js";
import { conversationService } from "../../modules/conversations/conversation-core.js";
import type { ConversationAccessService } from "../../modules/messages/message.service.js";
import { systemClock, type Clock } from "../../shared/time/clock.js";
import { socketMessagePublisher, type SocketMessagePublisher } from "../messages/message-publisher.js";
import { presenceService } from "../presence/presence-core.js";
import {
  socketPresencePublisher,
  type SocketPresencePublisher,
} from "../presence/presence-publisher.js";
import type { PresenceLifecycleService } from "../presence/presence.service.js";
import {
  socketReadPublisher,
  type SocketReadPublisher,
} from "../reads/read-publisher.js";
import { configureChatNamespace } from "./configure-chat-namespace.js";

export interface CreateSocketServerOptions {
  authenticator?: AccessAuthenticator;
  conversationAccessService?: ConversationAccessService;
  presenceService?: PresenceLifecycleService;
  presencePublisher?: SocketPresencePublisher;
  messagePublisher?: SocketMessagePublisher;
  readPublisher?: SocketReadPublisher;
  clock?: Clock;
}

export function createSocketServer(
  httpServer: HttpServer,
  options: CreateSocketServerOptions = {},
): SocketIoServer {
  const socketServer = new SocketIoServer(httpServer, {
    serveClient: false,
    cors: {
      origin: env.FRONTEND_ORIGIN,
      credentials: true,
    },
  });
  const chatNamespace = socketServer.of("/chat");
  const publisher = options.messagePublisher ?? socketMessagePublisher;
  const readPublisher = options.readPublisher ?? socketReadPublisher;
  const presencePublisher =
    options.presencePublisher ?? socketPresencePublisher;

  publisher.bind(chatNamespace);
  readPublisher.bind(chatNamespace);
  presencePublisher.bind(chatNamespace);
  configureChatNamespace(chatNamespace, {
    authenticator: options.authenticator ?? authService,
    conversationAccessService:
      options.conversationAccessService ?? conversationService,
    presenceService: options.presenceService ?? presenceService,
    clock: options.clock ?? systemClock,
  });

  return socketServer;
}
