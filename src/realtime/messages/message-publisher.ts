import type { Namespace } from "socket.io";

import type {
  MessageDto,
  MessagePublisher,
} from "../../modules/messages/message.service.js";
import { conversationRoom } from "../rooms/room-names.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
  MessageCreatedEventDto,
  MessageEventDto,
} from "../server/chat-events.js";

type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

export class SocketMessagePublisher implements MessagePublisher {
  private namespace: ChatNamespace | null = null;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishMessageCreated(message: MessageDto): void {
    this.namespace
      ?.to(conversationRoom(message.conversationId))
      .emit("message:created", { message: toMessageCreatedEventDto(message) });
  }

  publishMessageUpdated(message: MessageDto): void {
    this.namespace
      ?.to(conversationRoom(message.conversationId))
      .emit("message:updated", { message: toMessageEventDto(message) });
  }

  publishMessageDeleted(message: MessageDto): void {
    this.namespace
      ?.to(conversationRoom(message.conversationId))
      .emit("message:deleted", { message: toMessageEventDto(message) });
  }
}

function toMessageEventDto(message: MessageDto): MessageEventDto {
  return {
    ...message,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

function toMessageCreatedEventDto(
  message: MessageDto,
): MessageCreatedEventDto {
  return {
    ...message,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

export const socketMessagePublisher = new SocketMessagePublisher();
