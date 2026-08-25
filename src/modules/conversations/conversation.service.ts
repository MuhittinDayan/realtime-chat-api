import { encodeCursor } from "../../shared/pagination/cursor.js";
import { createDirectConversationKey } from "./direct-key.js";
import {
  CannotMessageSelfError,
  ConversationNotFoundError,
  UserNotFoundError,
} from "./conversation.errors.js";
import {
  DirectConversationUniqueConstraintError,
  type ConversationRepository,
  type ConversationUserRecord,
  type DirectConversationRecord,
} from "./conversation.repository.js";
import type { ListConversationsQuery } from "./conversation.schema.js";

export interface ConversationUserDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DirectConversationDto {
  id: string;
  type: "DIRECT";
  title: string | null;
  createdAt: Date;
  otherUser: ConversationUserDto;
}

export interface ListedDirectConversationDto
  extends DirectConversationDto {
  lastMessageAt: Date | null;
  lastMessage: {
    id: string;
    body: string;
    senderId: string;
    createdAt: Date;
  } | null;
  unreadCount: number;
}

export interface CreateDirectConversationResult {
  conversation: DirectConversationDto;
  created: boolean;
}

export interface ListConversationsResult {
  items: readonly ListedDirectConversationDto[];
  nextCursor: string | null;
}

export class ConversationService {
  constructor(
    private readonly conversationRepository: ConversationRepository,
  ) {}

  async isActiveMember(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    return this.conversationRepository.hasActiveMembership(
      conversationId,
      userId,
    );
  }

  async getOrCreateDirectConversation(
    currentUserId: string,
    targetUserId: string,
  ): Promise<CreateDirectConversationResult> {
    if (currentUserId.toLowerCase() === targetUserId.toLowerCase()) {
      throw new CannotMessageSelfError();
    }

    const targetUser =
      await this.conversationRepository.findAvailableUser(targetUserId);

    if (targetUser === null) {
      throw new UserNotFoundError();
    }

    const directKey = createDirectConversationKey(
      currentUserId,
      targetUser.id,
    );
    const existing =
      await this.conversationRepository.findDirectConversationByKey(
        directKey,
        currentUserId,
      );

    if (existing !== null) {
      return {
        conversation: toDirectConversationDto(existing, targetUser),
        created: false,
      };
    }

    try {
      const created =
        await this.conversationRepository.createDirectConversation({
          currentUserId,
          targetUserId: targetUser.id,
          directKey,
        });

      return {
        conversation: toDirectConversationDto(created, targetUser),
        created: true,
      };
    } catch (error: unknown) {
      if (!(error instanceof DirectConversationUniqueConstraintError)) {
        throw error;
      }

      const racedConversation =
        await this.conversationRepository.findDirectConversationByKey(
          directKey,
          currentUserId,
        );

      if (racedConversation === null) {
        throw error;
      }

      return {
        conversation: toDirectConversationDto(
          racedConversation,
          targetUser,
        ),
        created: false,
      };
    }
  }

  async listConversations(
    currentUserId: string,
    input: ListConversationsQuery,
  ): Promise<ListConversationsResult> {
    const records = await this.conversationRepository.listConversations({
      userId: currentUserId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      take: input.limit + 1,
    });
    const hasNextPage = records.length > input.limit;
    const page = records.slice(0, input.limit);

    return {
      items: page.map((record) => ({
        ...toDirectConversationDto(record),
        lastMessageAt: record.lastMessageAt,
        lastMessage: record.lastMessage,
        unreadCount: record.unreadCount,
      })),
      nextCursor: hasNextPage
        ? createNextCursor(page.at(-1))
        : null,
    };
  }

  async getConversation(
    currentUserId: string,
    conversationId: string,
  ): Promise<DirectConversationDto> {
    const conversation =
      await this.conversationRepository.findConversationForMember(
        conversationId,
        currentUserId,
      );

    if (conversation === null) {
      throw new ConversationNotFoundError();
    }

    return toDirectConversationDto(conversation);
  }
}

function toDirectConversationDto(
  conversation: DirectConversationRecord,
  knownOtherUser?: ConversationUserRecord,
): DirectConversationDto {
  if (conversation.type !== "DIRECT") {
    throw new Error("Unsupported conversation type");
  }

  const otherUser = knownOtherUser ?? conversation.members[0]?.user;

  if (otherUser === undefined) {
    throw new Error("Direct conversation is missing its other member");
  }

  return {
    id: conversation.id,
    type: conversation.type,
    title: conversation.title,
    createdAt: conversation.createdAt,
    otherUser: {
      id: otherUser.id,
      username: otherUser.username,
      displayName: otherUser.displayName,
      avatarUrl: otherUser.avatarUrl,
    },
  };
}

function createNextCursor(
  conversation: DirectConversationRecord | undefined,
): string {
  if (conversation === undefined) {
    throw new Error("Cannot create a cursor for an empty page");
  }

  return encodeCursor({
    v: 1,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    createdAt: conversation.createdAt.toISOString(),
    id: conversation.id,
  });
}
