import type { Namespace } from "socket.io";

import type {
  ReadPublisher,
  ReadUpdatedEvent,
} from "../../modules/reads/read.service.js";
import { conversationRoom } from "../rooms/room-names.js";
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

export class SocketReadPublisher implements ReadPublisher {
  private namespace: ChatNamespace | null = null;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishReadUpdated(event: ReadUpdatedEvent): void {
    this.namespace
      ?.to(conversationRoom(event.conversationId))
      .emit("read:updated", {
        ...event,
        readAt: event.readAt.toISOString(),
      });
  }
}

export const socketReadPublisher = new SocketReadPublisher();
