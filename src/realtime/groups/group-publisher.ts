import type { Namespace } from "socket.io";

import type {
  GroupConversationDto,
  GroupMemberDto,
  GroupPublisher,
} from "../../modules/conversations/conversation.service.js";
import { conversationRoom, userRoom } from "../rooms/room-names.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
  GroupConversationEventDto,
  GroupMemberEventDto,
} from "../server/chat-events.js";

type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

export class SocketGroupPublisher implements GroupPublisher {
  private namespace?: ChatNamespace;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishGroupCreated(conversation: GroupConversationDto): void {
    const rooms = [...new Set(conversation.members.map(({ userId }) => userId))].map(
      userRoom,
    );

    if (this.namespace === undefined || rooms.length === 0) {
      return;
    }

    this.namespace.to(rooms).emit("group:created", {
      conversation: toConversationEvent(conversation),
    });
  }

  publishGroupUpdated(conversation: GroupConversationDto): void {
    this.namespace?.to(conversationRoom(conversation.id)).emit("group:updated", {
      conversation: toConversationEvent(conversation),
    });
  }

  publishMemberAdded(conversationId: string, member: GroupMemberDto): void {
    this.namespace
      ?.to([conversationRoom(conversationId), userRoom(member.userId)])
      .emit("member:added", {
        conversationId,
        member: toMemberEvent(member),
      });
  }

  publishMemberRemoved(conversationId: string, userId: string): void {
    const namespace = this.namespace;
    namespace?.to(conversationRoom(conversationId)).emit("member:removed", {
      conversationId,
      userId,
    });
    namespace?.in(userRoom(userId)).socketsLeave(conversationRoom(conversationId));
  }

  publishMemberLeft(conversationId: string, userId: string): void {
    const namespace = this.namespace;
    namespace?.to(conversationRoom(conversationId)).emit("member:left", {
      conversationId,
      userId,
    });
    namespace?.in(userRoom(userId)).socketsLeave(conversationRoom(conversationId));
  }

  publishMemberRoleUpdated(conversationId: string, member: GroupMemberDto): void {
    this.namespace?.to(conversationRoom(conversationId)).emit("member:role-updated", {
      conversationId,
      member: toMemberEvent(member),
    });
  }

  publishOwnershipTransferred(
    conversation: GroupConversationDto,
    previousOwnerId: string,
    newOwnerId: string,
  ): void {
    this.namespace?.to(conversationRoom(conversation.id)).emit("ownership:transferred", {
      conversationId: conversation.id,
      previousOwnerId,
      newOwnerId,
    });
  }
}

function toConversationEvent(conversation: GroupConversationDto): GroupConversationEventDto {
  return {
    ...conversation,
    createdAt: conversation.createdAt.toISOString(),
    members: conversation.members.map(toMemberEvent),
  };
}

function toMemberEvent(member: GroupMemberDto): GroupMemberEventDto {
  return { ...member, joinedAt: member.joinedAt.toISOString() };
}

export const socketGroupPublisher = new SocketGroupPublisher();
