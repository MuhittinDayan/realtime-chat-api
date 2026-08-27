import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { ConversationType, MemberRole } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { ConversationListCursor } from "./conversation.schema.js";

export interface ConversationUserRecord { id: string; username: string; displayName: string; avatarUrl: string | null }
export interface ConversationMemberRecord { userId: string; role: MemberRole; joinedAt: Date; user: ConversationUserRecord }
export interface ConversationRecord { id: string; type: ConversationType; title: string | null; lastMessageAt: Date | null; createdAt: Date; members: readonly ConversationMemberRecord[] }
export type DirectConversationRecord = ConversationRecord;
export interface ConversationLastMessageRecord { id: string; body: string | null; senderId: string; createdAt: Date; deletedAt: Date | null }
export interface ListedConversationRecord extends ConversationRecord { lastMessage: ConversationLastMessageRecord | null; unreadCount: number }
export type ListedDirectConversationRecord = ListedConversationRecord;
export interface ListConversationsRepositoryInput { userId: string; cursor?: ConversationListCursor; take: number }
export type GroupMutationFailure = "CONVERSATION_NOT_FOUND" | "INSUFFICIENT_ROLE" | "TARGET_NOT_FOUND" | "TARGET_IS_OWNER" | "ALREADY_ACTIVE" | "MEMBER_LIMIT" | "LAST_OWNER" | "SAME_USER";
export type GroupMutationResult<T> = { status: "ok"; value: T } | { status: GroupMutationFailure };

export interface ConversationRepository {
  hasActiveMembership(conversationId: string, userId: string): Promise<boolean>;
  findAvailableUser(userId: string): Promise<ConversationUserRecord | null>;
  findDirectConversationByKey(directKey: string, currentUserId: string): Promise<DirectConversationRecord | null>;
  createDirectConversation(input: { currentUserId: string; targetUserId: string; directKey: string }): Promise<DirectConversationRecord>;
  createGroupConversation(input: { creatorId: string; title: string; userIds: readonly string[] }): Promise<ConversationRecord | null>;
  listConversations(input: ListConversationsRepositoryInput): Promise<readonly ListedConversationRecord[]>;
  findConversationForMember(conversationId: string, userId: string): Promise<ConversationRecord | null>;
  updateGroupTitle(input: { conversationId: string; actorId: string; title: string }): Promise<GroupMutationResult<ConversationRecord>>;
  addGroupMember(input: { conversationId: string; actorId: string; userId: string; joinedAt: Date }): Promise<GroupMutationResult<ConversationMemberRecord>>;
  removeGroupMember(input: { conversationId: string; actorId: string; userId: string; leftAt: Date }): Promise<GroupMutationResult<null>>;
  leaveGroup(input: { conversationId: string; actorId: string; leftAt: Date }): Promise<GroupMutationResult<null>>;
  updateGroupMemberRole(input: { conversationId: string; actorId: string; userId: string; role: "MEMBER" | "ADMIN" }): Promise<GroupMutationResult<ConversationMemberRecord>>;
  transferGroupOwnership(input: { conversationId: string; actorId: string; userId: string }): Promise<GroupMutationResult<ConversationRecord>>;
}

export class DirectConversationUniqueConstraintError extends Error {
  constructor(cause: unknown) { super("A direct conversation already exists", { cause }); this.name = "DirectConversationUniqueConstraintError" }
}

const publicUserSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;
const activeMemberSelect = { userId: true, role: true, joinedAt: true, user: { select: publicUserSelect } } satisfies Prisma.ConversationMemberSelect;
const conversationSelect = {
  id: true, type: true, title: true, lastMessageAt: true, createdAt: true,
  members: { where: { leftAt: null }, orderBy: [{ joinedAt: "asc" }, { userId: "asc" }], select: activeMemberSelect },
} satisfies Prisma.ConversationSelect;

function isDirectKeyUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  try { return JSON.stringify(error.meta ?? {}).toLowerCase().includes("direct") } catch { return false }
}

function createListCursorFilter(cursor: ConversationListCursor) {
  const createdAfterCursor = { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] };
  if (cursor.lastMessageAt === null) return { lastMessageAt: null, AND: [createdAfterCursor] };
  return { OR: [{ lastMessageAt: { lt: cursor.lastMessageAt } }, { lastMessageAt: null }, { lastMessageAt: cursor.lastMessageAt, AND: [createdAfterCursor] }] };
}

interface RawConversationSummaryRow { conversationId: string; lastMessageId: string | null; lastMessageBody: string | null; lastMessageSenderId: string | null; lastMessageCreatedAt: Date | null; lastMessageDeletedAt: Date | null; unreadCount: number | bigint }
interface GroupContext { actor: { role: MemberRole } }

export class PrismaConversationRepository implements ConversationRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async hasActiveMembership(conversationId: string, userId: string): Promise<boolean> {
    const membership = await this.client.conversationMember.findFirst({ where: { conversationId, userId, leftAt: null }, select: { conversationId: true } });
    return membership !== null;
  }

  async findAvailableUser(userId: string): Promise<ConversationUserRecord | null> {
    return this.client.user.findFirst({ where: { id: userId, status: "ACTIVE", deletedAt: null }, select: publicUserSelect });
  }

  async findDirectConversationByKey(directKey: string, _currentUserId: string): Promise<DirectConversationRecord | null> {
    return this.client.conversation.findUnique({ where: { directKey }, select: conversationSelect });
  }

  async createDirectConversation(input: { currentUserId: string; targetUserId: string; directKey: string }): Promise<DirectConversationRecord> {
    try {
      return await this.client.$transaction((transaction) => transaction.conversation.create({
        data: { type: "DIRECT", directKey: input.directKey, createdById: input.currentUserId, members: { create: [{ userId: input.currentUserId, role: "MEMBER" }, { userId: input.targetUserId, role: "MEMBER" }] } },
        select: conversationSelect,
      }));
    } catch (error: unknown) {
      if (isDirectKeyUniqueViolation(error)) throw new DirectConversationUniqueConstraintError(error);
      throw error;
    }
  }

  async createGroupConversation(input: { creatorId: string; title: string; userIds: readonly string[] }): Promise<ConversationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      const allUserIds = [input.creatorId, ...input.userIds];
      const availableUsers = await transaction.user.count({ where: { id: { in: allUserIds }, status: "ACTIVE", deletedAt: null } });
      if (availableUsers !== allUserIds.length) return null;
      return transaction.conversation.create({
        data: { type: "GROUP", title: input.title, createdById: input.creatorId, members: { create: [{ userId: input.creatorId, role: "OWNER" }, ...input.userIds.map((userId) => ({ userId, role: "MEMBER" as const }))] } },
        select: conversationSelect,
      });
    });
  }

  async listConversations(input: ListConversationsRepositoryInput): Promise<readonly ListedConversationRecord[]> {
    const conversations = await this.client.conversation.findMany({
      where: { members: { some: { userId: input.userId, leftAt: null } }, ...(input.cursor === undefined ? {} : { AND: [createListCursorFilter(input.cursor)] }) },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "desc" }], take: input.take, select: conversationSelect,
    });
    if (conversations.length === 0) return [];
    const summaries = await this.loadConversationSummaries(conversations.map((conversation) => conversation.id), input.userId);
    const byId = new Map(summaries.map((summary) => [summary.conversationId, summary]));
    return conversations.map((conversation) => {
      const summary = byId.get(conversation.id);
      return {
        ...conversation,
        lastMessage: summary?.lastMessageId == null || summary.lastMessageSenderId === null || summary.lastMessageCreatedAt === null ? null : {
          id: summary.lastMessageId, body: summary.lastMessageDeletedAt === null ? summary.lastMessageBody : null, senderId: summary.lastMessageSenderId, createdAt: summary.lastMessageCreatedAt, deletedAt: summary.lastMessageDeletedAt,
        },
        unreadCount: Number(summary?.unreadCount ?? 0),
      };
    });
  }

  async findConversationForMember(conversationId: string, userId: string): Promise<ConversationRecord | null> {
    return this.client.conversation.findFirst({ where: { id: conversationId, members: { some: { userId, leftAt: null } } }, select: conversationSelect });
  }

  async updateGroupTitle(input: { conversationId: string; actorId: string; title: string }): Promise<GroupMutationResult<ConversationRecord>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      if (!isManager(context.actor.role)) return { status: "INSUFFICIENT_ROLE" };
      return { status: "ok", value: await tx.conversation.update({ where: { id: input.conversationId }, data: { title: input.title }, select: conversationSelect }) };
    });
  }

  async addGroupMember(input: { conversationId: string; actorId: string; userId: string; joinedAt: Date }): Promise<GroupMutationResult<ConversationMemberRecord>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      if (!isManager(context.actor.role)) return { status: "INSUFFICIENT_ROLE" };
      const target = await tx.user.findFirst({ where: { id: input.userId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
      if (target === null) return { status: "TARGET_NOT_FOUND" };
      const key = { conversationId_userId: { conversationId: input.conversationId, userId: input.userId } };
      const existing = await tx.conversationMember.findUnique({ where: key, select: { leftAt: true } });
      if (existing?.leftAt === null) return { status: "ALREADY_ACTIVE" };
      const activeCount = await tx.conversationMember.count({ where: { conversationId: input.conversationId, leftAt: null } });
      if (activeCount >= 100) return { status: "MEMBER_LIMIT" };
      const value = existing === null
        ? await tx.conversationMember.create({ data: { conversationId: input.conversationId, userId: input.userId, role: "MEMBER", joinedAt: input.joinedAt }, select: activeMemberSelect })
        : await tx.conversationMember.update({ where: key, data: { role: "MEMBER", joinedAt: input.joinedAt, leftAt: null }, select: activeMemberSelect });
      return { status: "ok", value };
    });
  }

  async removeGroupMember(input: { conversationId: string; actorId: string; userId: string; leftAt: Date }): Promise<GroupMutationResult<null>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      if (input.actorId === input.userId) return { status: "SAME_USER" };
      const key = { conversationId_userId: { conversationId: input.conversationId, userId: input.userId } };
      const target = await tx.conversationMember.findUnique({ where: key, select: { role: true, leftAt: true } });
      if (target === null || target.leftAt !== null) return { status: "TARGET_NOT_FOUND" };
      if (target.role === "OWNER") return { status: "TARGET_IS_OWNER" };
      if (!isManager(context.actor.role)) return { status: "INSUFFICIENT_ROLE" };
      await tx.conversationMember.update({ where: key, data: { leftAt: input.leftAt } });
      return { status: "ok", value: null };
    });
  }

  async leaveGroup(input: { conversationId: string; actorId: string; leftAt: Date }): Promise<GroupMutationResult<null>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      if (context.actor.role === "OWNER") {
        const activeCount = await tx.conversationMember.count({ where: { conversationId: input.conversationId, leftAt: null } });
        if (activeCount === 1) return { status: "LAST_OWNER" };
      }
      const key = { conversationId_userId: { conversationId: input.conversationId, userId: input.actorId } };
      await tx.conversationMember.update({ where: key, data: { leftAt: input.leftAt } });
      return { status: "ok", value: null };
    });
  }

  async updateGroupMemberRole(input: { conversationId: string; actorId: string; userId: string; role: "MEMBER" | "ADMIN" }): Promise<GroupMutationResult<ConversationMemberRecord>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      const key = { conversationId_userId: { conversationId: input.conversationId, userId: input.userId } };
      const target = await tx.conversationMember.findUnique({ where: key, select: { role: true, leftAt: true } });
      if (target === null || target.leftAt !== null) return { status: "TARGET_NOT_FOUND" };
      if (target.role === "OWNER") return { status: "TARGET_IS_OWNER" };
      if (context.actor.role !== "OWNER") return { status: "INSUFFICIENT_ROLE" };
      const value = await tx.conversationMember.update({ where: key, data: { role: input.role }, select: activeMemberSelect });
      return { status: "ok", value };
    });
  }

  async transferGroupOwnership(input: { conversationId: string; actorId: string; userId: string }): Promise<GroupMutationResult<ConversationRecord>> {
    return this.withLockedGroup(input.conversationId, async (tx) => {
      const context = await this.loadGroupContext(tx, input.conversationId, input.actorId);
      if (context === null) return { status: "CONVERSATION_NOT_FOUND" };
      if (context.actor.role !== "OWNER") return { status: "INSUFFICIENT_ROLE" };
      if (input.actorId === input.userId) return { status: "SAME_USER" };
      const key = { conversationId_userId: { conversationId: input.conversationId, userId: input.userId } };
      const target = await tx.conversationMember.findUnique({ where: key, select: { leftAt: true } });
      if (target === null || target.leftAt !== null) return { status: "TARGET_NOT_FOUND" };
      await tx.conversationMember.updateMany({ where: { conversationId: input.conversationId, leftAt: null, role: "OWNER" }, data: { role: "ADMIN" } });
      await tx.conversationMember.update({ where: key, data: { role: "OWNER" } });
      const value = await tx.conversation.findUniqueOrThrow({ where: { id: input.conversationId }, select: conversationSelect });
      return { status: "ok", value };
    });
  }

  private async withLockedGroup<T>(conversationId: string, operation: (transaction: Prisma.TransactionClient) => Promise<GroupMutationResult<T>>): Promise<GroupMutationResult<T>> {
    return this.client.$transaction(async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${conversationId}))::text AS "lock"`,
      );
      return operation(transaction);
    });
  }

  private async loadGroupContext(transaction: Prisma.TransactionClient, conversationId: string, actorId: string): Promise<GroupContext | null> {
    const conversation = await transaction.conversation.findUnique({ where: { id: conversationId }, select: { type: true } });
    if (conversation?.type !== "GROUP") return null;
    const actor = await transaction.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: actorId } }, select: { role: true, leftAt: true } });
    if (actor === null || actor.leftAt !== null) return null;
    return { actor: { role: actor.role } };
  }

  private loadConversationSummaries(conversationIds: readonly string[], userId: string): Promise<RawConversationSummaryRow[]> {
    return this.client.$queryRaw<RawConversationSummaryRow[]>(Prisma.sql`
      SELECT conversation.id AS "conversationId", last_message.id AS "lastMessageId", last_message.body AS "lastMessageBody",
        last_message.sender_id AS "lastMessageSenderId", last_message.created_at AS "lastMessageCreatedAt",
        last_message.deleted_at AS "lastMessageDeletedAt", COALESCE(unread.unread_count, 0)::integer AS "unreadCount"
      FROM conversations AS conversation
      LEFT JOIN message_reads AS watermark ON watermark.conversation_id = conversation.id AND watermark.user_id = ${userId}::uuid
      LEFT JOIN messages AS watermark_message ON watermark_message.id = watermark.last_read_message_id
      LEFT JOIN LATERAL (SELECT id, body, sender_id, created_at, deleted_at FROM messages WHERE conversation_id = conversation.id ORDER BY created_at DESC, id DESC LIMIT 1) AS last_message ON TRUE
      LEFT JOIN LATERAL (SELECT COUNT(*) AS unread_count FROM messages AS unread_message WHERE unread_message.conversation_id = conversation.id AND unread_message.sender_id <> ${userId}::uuid AND (watermark_message.id IS NULL OR (unread_message.created_at, unread_message.id) > (watermark_message.created_at, watermark_message.id))) AS unread ON TRUE
      WHERE conversation.id IN (${Prisma.join(conversationIds)})
    `);
  }
}

function isManager(role: MemberRole): boolean { return role === "OWNER" || role === "ADMIN" }
