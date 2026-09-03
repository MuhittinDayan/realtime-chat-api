import type {
  BaseMessageDto,
  MessageDto,
} from "../../modules/messages/message.service.js";
import type { PublicUserProfile } from "../../modules/users/user-profile-change.service.js";

export interface GroupMemberEventDto {
  userId: string;
  role: "MEMBER" | "ADMIN" | "OWNER";
  joinedAt: string;
  user: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

export interface GroupConversationEventDto {
  id: string;
  type: "GROUP";
  title: string;
  createdAt: string;
  members: readonly GroupMemberEventDto[];
}

type SerializedMessage<T extends BaseMessageDto> = T extends BaseMessageDto
  ? Omit<T, "createdAt" | "editedAt" | "deletedAt"> & {
      createdAt: string;
      editedAt: string | null;
      deletedAt: string | null;
    }
  : never;

export type MessageCreatedEventDto = SerializedMessage<MessageDto>;

export type MessageEventDto = SerializedMessage<MessageDto>;

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
  "auth:revoked": () => void;
  "session:ready": (payload: {
    userId: string;
    socketId: string;
    serverTime: string;
  }) => void;
  "user:updated": (payload: { user: PublicUserProfile }) => void;
  "message:created": (payload: { message: MessageCreatedEventDto }) => void;
  "message:updated": (payload: { message: MessageEventDto }) => void;
  "message:deleted": (payload: { message: MessageEventDto }) => void;
  "notification:created": (payload: {
    id: string;
    type: "MESSAGE_CREATED";
    conversationId: string;
    messageId: string;
    createdAt: string;
  }) => void;
  "notification:read": (payload: {
    id: string;
    readAt: string;
  }) => void;
  "notifications:read": (payload: {
    conversationId: string;
    markedCount: number;
  }) => void;
  "group:created": (payload: { conversation: GroupConversationEventDto }) => void;
  "group:updated": (payload: { conversation: GroupConversationEventDto }) => void;
  "member:added": (payload: { conversationId: string; member: GroupMemberEventDto }) => void;
  "member:removed": (payload: { conversationId: string; userId: string }) => void;
  "member:left": (payload: { conversationId: string; userId: string }) => void;
  "member:role-updated": (payload: { conversationId: string; member: GroupMemberEventDto }) => void;
  "ownership:transferred": (payload: { conversationId: string; previousOwnerId: string; newOwnerId: string }) => void;
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
