import { encodeCursor } from "../../shared/pagination/cursor.js";
import { RequestValidationError } from "../../shared/errors/request-validation-error.js";
import { systemClock, type Clock } from "../../shared/time/clock.js";
import { createDirectConversationKey } from "./direct-key.js";
import {
  CannotMessageSelfError,
  ConversationConflictError,
  ConversationNotFoundError,
  InsufficientRoleError,
  InvalidConversationOperationError,
  UserNotFoundError,
} from "./conversation.errors.js";
import {
  DirectConversationUniqueConstraintError,
  type ConversationMemberRecord,
  type ConversationRecord,
  type ConversationRepository,
  type ConversationUserRecord,
  type GroupMutationFailure,
  type ListedConversationRecord,
} from "./conversation.repository.js";
import type {
  AddGroupMemberBody,
  CreateGroupConversationBody,
  ListConversationsQuery,
  TransferGroupOwnershipBody,
  UpdateGroupMemberRoleBody,
  UpdateGroupTitleBody,
} from "./conversation.schema.js";

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

export interface GroupMemberDto {
  userId: string;
  role: "MEMBER" | "ADMIN" | "OWNER";
  joinedAt: Date;
  user: ConversationUserDto;
}

export interface GroupConversationDto {
  id: string;
  type: "GROUP";
  title: string;
  createdAt: Date;
  members: readonly GroupMemberDto[];
}

export type ConversationDto = DirectConversationDto | GroupConversationDto;

export type ListedConversationDto = ConversationDto & {
  lastMessageAt: Date | null;
  lastMessage: {
    id: string;
    body: string | null;
    senderId: string;
    createdAt: Date;
    deletedAt: Date | null;
  } | null;
  unreadCount: number;
};

export type ListedDirectConversationDto = ListedConversationDto;

export interface CreateDirectConversationResult {
  conversation: DirectConversationDto;
  created: boolean;
}

export interface ListConversationsResult {
  items: readonly ListedConversationDto[];
  nextCursor: string | null;
}

export interface GroupPublisher {
  publishGroupCreated(conversation: GroupConversationDto): Promise<void> | void;
  publishGroupUpdated(conversation: GroupConversationDto): Promise<void> | void;
  publishMemberAdded(conversationId: string, member: GroupMemberDto): Promise<void> | void;
  publishMemberRemoved(conversationId: string, userId: string): Promise<void> | void;
  publishMemberLeft(conversationId: string, userId: string): Promise<void> | void;
  publishMemberRoleUpdated(conversationId: string, member: GroupMemberDto): Promise<void> | void;
  publishOwnershipTransferred(conversation: GroupConversationDto, previousOwnerId: string, newOwnerId: string): Promise<void> | void;
}

const noopGroupPublisher: GroupPublisher = {
  publishGroupCreated: () => undefined,
  publishGroupUpdated: () => undefined,
  publishMemberAdded: () => undefined,
  publishMemberRemoved: () => undefined,
  publishMemberLeft: () => undefined,
  publishMemberRoleUpdated: () => undefined,
  publishOwnershipTransferred: () => undefined,
};

export class ConversationService {
  constructor(
    private readonly conversationRepository: ConversationRepository,
    private readonly groupPublisher: GroupPublisher = noopGroupPublisher,
    private readonly clock: Clock = systemClock,
  ) {}

  async isActiveMember(conversationId: string, userId: string): Promise<boolean> {
    return this.conversationRepository.hasActiveMembership(conversationId, userId);
  }

  async getOrCreateDirectConversation(currentUserId: string, targetUserId: string): Promise<CreateDirectConversationResult> {
    if (currentUserId.toLowerCase() === targetUserId.toLowerCase()) throw new CannotMessageSelfError();
    const targetUser = await this.conversationRepository.findAvailableUser(targetUserId);
    if (targetUser === null) throw new UserNotFoundError();
    const directKey = createDirectConversationKey(currentUserId, targetUser.id);
    const existing = await this.conversationRepository.findDirectConversationByKey(directKey, currentUserId);
    if (existing !== null) return { conversation: toDirectConversationDto(existing, currentUserId, targetUser), created: false };
    try {
      const created = await this.conversationRepository.createDirectConversation({ currentUserId, targetUserId: targetUser.id, directKey });
      return { conversation: toDirectConversationDto(created, currentUserId, targetUser), created: true };
    } catch (error: unknown) {
      if (!(error instanceof DirectConversationUniqueConstraintError)) throw error;
      const raced = await this.conversationRepository.findDirectConversationByKey(directKey, currentUserId);
      if (raced === null) throw error;
      return { conversation: toDirectConversationDto(raced, currentUserId, targetUser), created: false };
    }
  }

  async createGroupConversation(currentUserId: string, input: CreateGroupConversationBody): Promise<GroupConversationDto> {
    const normalizedCreatorId = currentUserId.toLowerCase();
    const normalizedIds = input.userIds.map((id) => id.toLowerCase());
    if (normalizedIds.includes(normalizedCreatorId) || new Set(normalizedIds).size !== normalizedIds.length) {
      throw new RequestValidationError([{ path: "body.userIds", message: "Creator must not be included and user ids must be unique" }]);
    }
    const record = await this.conversationRepository.createGroupConversation({ creatorId: currentUserId, title: input.title, userIds: input.userIds });
    if (record === null) throw new UserNotFoundError();
    const conversation = toGroupConversationDto(record);
    await this.groupPublisher.publishGroupCreated(conversation);
    return conversation;
  }

  async listConversations(currentUserId: string, input: ListConversationsQuery): Promise<ListConversationsResult> {
    const records = await this.conversationRepository.listConversations({ userId: currentUserId, ...(input.cursor === undefined ? {} : { cursor: input.cursor }), take: input.limit + 1 });
    const hasNextPage = records.length > input.limit;
    const page = records.slice(0, input.limit);
    return {
      items: page.map((record) => ({ ...toConversationDto(record, currentUserId), lastMessageAt: record.lastMessageAt, lastMessage: record.lastMessage, unreadCount: record.unreadCount })),
      nextCursor: hasNextPage ? createNextCursor(page.at(-1)) : null,
    };
  }

  async getConversation(currentUserId: string, conversationId: string): Promise<ConversationDto> {
    const conversation = await this.conversationRepository.findConversationForMember(conversationId, currentUserId);
    if (conversation === null) throw new ConversationNotFoundError();
    return toConversationDto(conversation, currentUserId);
  }

  async updateGroupTitle(currentUserId: string, conversationId: string, input: UpdateGroupTitleBody): Promise<GroupConversationDto> {
    const result = await this.conversationRepository.updateGroupTitle({ conversationId, actorId: currentUserId, title: input.title });
    if (result.status !== "ok") throwGroupFailure(result.status);
    const conversation = toGroupConversationDto(result.value);
    await this.groupPublisher.publishGroupUpdated(conversation);
    return conversation;
  }

  async addGroupMember(currentUserId: string, conversationId: string, input: AddGroupMemberBody): Promise<GroupMemberDto> {
    const result = await this.conversationRepository.addGroupMember({ conversationId, actorId: currentUserId, userId: input.userId, joinedAt: this.clock.now() });
    if (result.status !== "ok") {
      if (result.status === "ALREADY_ACTIVE") throw new ConversationConflictError("User is already an active member");
      if (result.status === "MEMBER_LIMIT") throw new ConversationConflictError("Group has reached the 100 active member limit");
      if (result.status === "TARGET_NOT_FOUND") throw new UserNotFoundError();
      throwGroupFailure(result.status);
    }
    const member = toGroupMemberDto(result.value);
    await this.groupPublisher.publishMemberAdded(conversationId, member);
    return member;
  }

  async removeGroupMember(currentUserId: string, conversationId: string, userId: string): Promise<void> {
    const result = await this.conversationRepository.removeGroupMember({ conversationId, actorId: currentUserId, userId, leftAt: this.clock.now() });
    if (result.status !== "ok") {
      if (result.status === "SAME_USER") throw new InvalidConversationOperationError("Use /members/me to leave the group");
      if (result.status === "TARGET_IS_OWNER") throw ownershipMustBeTransferredError();
      throwGroupFailure(result.status);
    }
    await this.groupPublisher.publishMemberRemoved(conversationId, userId);
  }

  async leaveGroup(currentUserId: string, conversationId: string): Promise<void> {
    const result = await this.conversationRepository.leaveGroup({ conversationId, actorId: currentUserId, leftAt: this.clock.now() });
    if (result.status !== "ok") {
      if (result.status === "LAST_OWNER") throw new ConversationConflictError("The last OWNER cannot leave the group");
      throwGroupFailure(result.status);
    }
    await this.groupPublisher.publishMemberLeft(conversationId, currentUserId);
  }

  async updateGroupMemberRole(currentUserId: string, conversationId: string, userId: string, input: UpdateGroupMemberRoleBody): Promise<GroupMemberDto> {
    const result = await this.conversationRepository.updateGroupMemberRole({ conversationId, actorId: currentUserId, userId, role: input.role });
    if (result.status !== "ok") {
      if (result.status === "TARGET_IS_OWNER") throw ownershipMustBeTransferredError();
      throwGroupFailure(result.status);
    }
    const member = toGroupMemberDto(result.value);
    await this.groupPublisher.publishMemberRoleUpdated(conversationId, member);
    return member;
  }

  async transferGroupOwnership(currentUserId: string, conversationId: string, input: TransferGroupOwnershipBody): Promise<GroupConversationDto> {
    const result = await this.conversationRepository.transferGroupOwnership({ conversationId, actorId: currentUserId, userId: input.userId });
    if (result.status !== "ok") {
      if (result.status === "SAME_USER") throw new ConversationConflictError("User is already the OWNER");
      throwGroupFailure(result.status);
    }
    const conversation = toGroupConversationDto(result.value);
    await this.groupPublisher.publishOwnershipTransferred(conversation, currentUserId, input.userId);
    return conversation;
  }
}

function throwGroupFailure(status: GroupMutationFailure): never {
  if (status === "INSUFFICIENT_ROLE") throw new InsufficientRoleError();
  if (status === "TARGET_IS_OWNER") throw ownershipMustBeTransferredError();
  if (status === "ALREADY_ACTIVE") throw new ConversationConflictError("User is already an active member");
  if (status === "MEMBER_LIMIT") throw new ConversationConflictError("Group has reached the 100 active member limit");
  if (status === "LAST_OWNER") throw new ConversationConflictError("The last OWNER cannot leave the group");
  if (status === "SAME_USER") throw new InvalidConversationOperationError("Invalid member operation");
  throw new ConversationNotFoundError();
}

function ownershipMustBeTransferredError(): ConversationConflictError {
  return new ConversationConflictError("Ownership must be transferred first");
}

function toConversationDto(conversation: ConversationRecord, currentUserId: string): ConversationDto {
  return conversation.type === "DIRECT" ? toDirectConversationDto(conversation, currentUserId) : toGroupConversationDto(conversation);
}

function toDirectConversationDto(conversation: ConversationRecord, currentUserId: string, knownOtherUser?: ConversationUserRecord): DirectConversationDto {
  if (conversation.type !== "DIRECT") throw new Error("Unsupported conversation type");
  const otherUser = knownOtherUser ?? conversation.members.find((member) => member.userId.toLowerCase() !== currentUserId.toLowerCase())?.user;
  if (otherUser === undefined) throw new Error("Direct conversation is missing its other member");
  return { id: conversation.id, type: "DIRECT", title: conversation.title, createdAt: conversation.createdAt, otherUser: toUserDto(otherUser) };
}

function toGroupConversationDto(conversation: ConversationRecord): GroupConversationDto {
  if (conversation.type !== "GROUP" || conversation.title === null) throw new Error("Group conversation is invalid");
  return { id: conversation.id, type: "GROUP", title: conversation.title, createdAt: conversation.createdAt, members: conversation.members.map(toGroupMemberDto) };
}

function toGroupMemberDto(member: ConversationMemberRecord): GroupMemberDto {
  return { userId: member.userId, role: member.role, joinedAt: member.joinedAt, user: toUserDto(member.user) };
}

function toUserDto(user: ConversationUserRecord): ConversationUserDto {
  return { id: user.id, username: user.username, displayName: user.displayName, avatarUrl: user.avatarUrl };
}

function createNextCursor(conversation: ListedConversationRecord | undefined): string | null {
  if (conversation === undefined) return null;
  return encodeCursor({ v: 1, lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null, createdAt: conversation.createdAt.toISOString(), id: conversation.id });
}
