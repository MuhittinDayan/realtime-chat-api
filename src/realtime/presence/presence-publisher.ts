import type { Namespace } from "socket.io";

import type {
  PresencePublisher,
  PresenceUpdatedEvent,
} from "./presence.service.js";
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

export class SocketPresencePublisher implements PresencePublisher {
  private namespace: ChatNamespace | null = null;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishToUsers(
    userIds: readonly string[],
    event: PresenceUpdatedEvent,
  ): void {
    const rooms = [...new Set(userIds)].map(userRoom);

    if (this.namespace === null || rooms.length === 0) {
      return;
    }

    this.namespace.to(rooms).emit("presence:updated", {
      userId: event.userId,
      status: event.status,
      lastSeenAt: event.lastSeenAt?.toISOString() ?? null,
    });
  }
}

export const socketPresencePublisher = new SocketPresencePublisher();
