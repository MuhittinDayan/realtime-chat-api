import type { Namespace } from "socket.io";

import type {
  ConversationNotificationsReadEvent,
  NotificationCreatedEvent,
  NotificationPublisher,
  NotificationReadEvent,
} from "../../modules/notifications/notification.events.js";
import { userRoom } from "../rooms/room-names.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
} from "../server/chat-events.js";

type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

export class SocketNotificationPublisher implements NotificationPublisher {
  private namespace?: ChatNamespace;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishCreated(event: NotificationCreatedEvent): void {
    this.namespace?.to(userRoom(event.recipientUserId)).emit(
      "notification:created",
      {
        id: event.id,
        type: event.type,
        conversationId: event.conversationId,
        messageId: event.messageId,
        createdAt: event.createdAt.toISOString(),
      },
    );
  }

  publishRead(event: NotificationReadEvent): void {
    this.namespace?.to(userRoom(event.recipientUserId)).emit(
      "notification:read",
      {
        id: event.id,
        readAt: event.readAt.toISOString(),
      },
    );
  }

  publishConversationRead(event: ConversationNotificationsReadEvent): void {
    this.namespace?.to(userRoom(event.recipientUserId)).emit(
      "notifications:read",
      {
        conversationId: event.conversationId,
        markedCount: event.markedCount,
      },
    );
  }
}

export const socketNotificationPublisher = new SocketNotificationPublisher();
