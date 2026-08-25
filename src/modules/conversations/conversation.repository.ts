import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import type { ConversationType } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { ConversationListCursor } from "./conversation.schema.js";

export interface ConversationUserRecord {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface DirectConversationRecord {
  id: string;
  type: ConversationType;
  title: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  members: readonly { user: ConversationUserRecord }[];
}

export interface ConversationLastMessageRecord {
  id: string;
  body: string;
  senderId: string;
  createdAt: Date;
}

export interface ListedDirectConversationRecord
  extends DirectConversationRecord {
  lastMessage: ConversationLastMessageRecord | null;
  unreadCount: number;
}

export interface ListConversationsRepositoryInput {
  userId: string;
  cursor?: ConversationListCursor;
  take: number;
}

export interface ConversationRepository {
  hasActiveMembership(
    conversationId: string,
    userId: string,
  ): Promise<boolean>;
  findAvailableUser(userId: string): Promise<ConversationUserRecord | null>;
  findDirectConversationByKey(
    directKey: string,
    currentUserId: string,
  ): Promise<DirectConversationRecord | null>;
  createDirectConversation(input: {
    currentUserId: string;
    targetUserId: string;
    directKey: string;
  }): Promise<DirectConversationRecord>;
  listConversations(
    input: ListConversationsRepositoryInput,
  ): Promise<readonly ListedDirectConversationRecord[]>;
  findConversationForMember(
    conversationId: string,
    userId: string,
  ): Promise<DirectConversationRecord | null>;
}

export class DirectConversationUniqueConstraintError extends Error {
  constructor(cause: unknown) {
    super("A direct conversation already exists", { cause });
    this.name = "DirectConversationUniqueConstraintError";
  }
}

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
} as const;

function conversationSelect(currentUserId: string) {
  return {
    id: true,
    type: true,
    title: true,
    lastMessageAt: true,
    createdAt: true,
    members: {
      where: {
        userId: { not: currentUserId },
        leftAt: null,
      },
      select: { user: { select: publicUserSelect } },
    },
  } as const;
}

function isDirectKeyUniqueViolation(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  try {
    return JSON.stringify(error.meta ?? {})
      .toLowerCase()
      .includes("direct");
  } catch {
    return false;
  }
}

function createListCursorFilter(cursor: ConversationListCursor) {
  const createdAfterCursor = {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };

  if (cursor.lastMessageAt === null) {
    return {
      lastMessageAt: null,
      AND: [createdAfterCursor],
    };
  }

  return {
    OR: [
      { lastMessageAt: { lt: cursor.lastMessageAt } },
      { lastMessageAt: null },
      {
        lastMessageAt: cursor.lastMessageAt,
        AND: [createdAfterCursor],
      },
    ],
  };
}

interface RawConversationSummaryRow {
  conversationId: string;
  lastMessageId: string | null;
  lastMessageBody: string | null;
  lastMessageSenderId: string | null;
  lastMessageCreatedAt: Date | null;
  unreadCount: number | bigint;
}

export class PrismaConversationRepository implements ConversationRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async hasActiveMembership(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    const membership = await this.client.conversationMember.findFirst({
      where: {
        conversationId,
        userId,
        leftAt: null,
        conversation: { type: "DIRECT" },
      },
      select: { conversationId: true },
    });

    return membership !== null;
  }

  async findAvailableUser(
    userId: string,
  ): Promise<ConversationUserRecord | null> {
    return this.client.user.findFirst({
      where: { id: userId, status: "ACTIVE", deletedAt: null },
      select: publicUserSelect,
    });
  }

  async findDirectConversationByKey(
    directKey: string,
    currentUserId: string,
  ): Promise<DirectConversationRecord | null> {
    return this.client.conversation.findUnique({
      where: { directKey },
      select: conversationSelect(currentUserId),
    });
  }

  async createDirectConversation(input: {
    currentUserId: string;
    targetUserId: string;
    directKey: string;
  }): Promise<DirectConversationRecord> {
    try {
      return await this.client.$transaction((transaction) =>
        transaction.conversation.create({
          data: {
            type: "DIRECT",
            directKey: input.directKey,
            createdById: input.currentUserId,
            members: {
              create: [
                { userId: input.currentUserId, role: "MEMBER" },
                { userId: input.targetUserId, role: "MEMBER" },
              ],
            },
          },
          select: conversationSelect(input.currentUserId),
        }),
      );
    } catch (error: unknown) {
      if (isDirectKeyUniqueViolation(error)) {
        throw new DirectConversationUniqueConstraintError(error);
      }

      throw error;
    }
  }

  async listConversations(
    input: ListConversationsRepositoryInput,
  ): Promise<readonly ListedDirectConversationRecord[]> {
    const conversations = await this.client.conversation.findMany({
      where: {
        type: "DIRECT",
        members: {
          some: { userId: input.userId, leftAt: null },
        },
        ...(input.cursor === undefined
          ? {}
          : { AND: [createListCursorFilter(input.cursor)] }),
      },
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: input.take,
      select: conversationSelect(input.userId),
    });

    if (conversations.length === 0) {
      return [];
    }

    const summaries = await this.loadConversationSummaries(
      conversations.map((conversation) => conversation.id),
      input.userId,
    );
    const summariesByConversationId = new Map(
      summaries.map((summary) => [summary.conversationId, summary]),
    );

    return conversations.map((conversation) => {
      const summary = summariesByConversationId.get(conversation.id);

      return {
        ...conversation,
        lastMessage:
          summary?.lastMessageId === null ||
          summary?.lastMessageId === undefined ||
          summary.lastMessageBody === null ||
          summary.lastMessageSenderId === null ||
          summary.lastMessageCreatedAt === null
            ? null
            : {
                id: summary.lastMessageId,
                body: summary.lastMessageBody,
                senderId: summary.lastMessageSenderId,
                createdAt: summary.lastMessageCreatedAt,
              },
        unreadCount: Number(summary?.unreadCount ?? 0),
      };
    });
  }

  async findConversationForMember(
    conversationId: string,
    userId: string,
  ): Promise<DirectConversationRecord | null> {
    return this.client.conversation.findFirst({
      where: {
        id: conversationId,
        type: "DIRECT",
        members: { some: { userId, leftAt: null } },
      },
      select: conversationSelect(userId),
    });
  }

  private loadConversationSummaries(
    conversationIds: readonly string[],
    userId: string,
  ): Promise<RawConversationSummaryRow[]> {
    return this.client.$queryRaw<RawConversationSummaryRow[]>(Prisma.sql`
      SELECT
        conversation.id AS "conversationId",
        last_message.id AS "lastMessageId",
        last_message.body AS "lastMessageBody",
        last_message.sender_id AS "lastMessageSenderId",
        last_message.created_at AS "lastMessageCreatedAt",
        COALESCE(unread.unread_count, 0)::integer AS "unreadCount"
      FROM conversations AS conversation
      LEFT JOIN message_reads AS watermark
        ON watermark.conversation_id = conversation.id
       AND watermark.user_id = ${userId}::uuid
      LEFT JOIN messages AS watermark_message
        ON watermark_message.id = watermark.last_read_message_id
      LEFT JOIN LATERAL (
        SELECT id, body, sender_id, created_at
        FROM messages
        WHERE conversation_id = conversation.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) AS last_message ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS unread_count
        FROM messages AS unread_message
        WHERE unread_message.conversation_id = conversation.id
          AND unread_message.sender_id <> ${userId}::uuid
          AND (
            watermark_message.id IS NULL
            OR (unread_message.created_at, unread_message.id)
              > (watermark_message.created_at, watermark_message.id)
          )
      ) AS unread ON TRUE
      WHERE conversation.id IN (${Prisma.join(conversationIds)})
    `);
  }
}
