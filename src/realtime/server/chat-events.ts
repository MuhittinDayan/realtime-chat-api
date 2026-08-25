import type { MessageDto } from "../../modules/messages/message.service.js";

export interface MessageEventDto
  extends Omit<MessageDto, "createdAt" | "editedAt"> {
  createdAt: string;
  editedAt: string | null;
}

export interface ConversationEventPayload {
  conversationId: string;
}

export type ConversationSubscriptionAck =
  | { ok: true }
  | { ok: false; error: { code: "FORBIDDEN" | "VALIDATION_ERROR" } };

export type PresenceSubscriptionAck =
  | {
      ok: true;
      data: Record<
        string,
        {
          status: "online" | "offline";
          lastSeenAt: string | null;
        }
      >;
    }
  | { ok: false; error: { code: "VALIDATION_ERROR" } };

export interface ChatClientToServerEvents {
  "conversation:subscribe": (
    payload: ConversationEventPayload,
    acknowledge: (response: ConversationSubscriptionAck) => void,
  ) => void;
  "conversation:unsubscribe": (
    payload: ConversationEventPayload,
    acknowledge: (response: ConversationSubscriptionAck) => void,
  ) => void;
  "typing:set": (payload: {
    conversationId: string;
    isTyping: boolean;
  }) => void;
  "presence:subscribe": (
    payload: { userIds: string[] },
    acknowledge: (response: PresenceSubscriptionAck) => void,
  ) => void;
}

export interface ChatServerToClientEvents {
  "session:ready": (payload: {
    userId: string;
    socketId: string;
    serverTime: string;
  }) => void;
  "message:created": (payload: { message: MessageEventDto }) => void;
  "read:updated": (payload: {
    conversationId: string;
    readerId: string;
    throughMessageId: string;
    readAt: string;
  }) => void;
  "typing:updated": (payload: {
    conversationId: string;
    userId: string;
    isTyping: boolean;
    expiresAt: string;
  }) => void;
  "presence:updated": (payload: {
    userId: string;
    status: "online" | "offline";
    lastSeenAt: string | null;
  }) => void;
}

export interface ChatInterServerEvents {}

export interface ChatSocketData {
  userId: string;
  sessionId: string;
}
