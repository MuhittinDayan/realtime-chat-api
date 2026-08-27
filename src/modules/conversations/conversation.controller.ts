import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/auth.middleware.js";
import type {
  AddGroupMemberBody,
  ConversationParams,
  CreateDirectConversationBody,
  CreateGroupConversationBody,
  GroupMemberParams,
  ListConversationsQuery,
  TransferGroupOwnershipBody,
  UpdateGroupMemberRoleBody,
  UpdateGroupTitleBody,
} from "./conversation.schema.js";
import type {
  ConversationDto,
  CreateDirectConversationResult,
  GroupConversationDto,
  GroupMemberDto,
  ListConversationsResult,
} from "./conversation.service.js";

export interface ConversationHttpService {
  getOrCreateDirectConversation(currentUserId: string, targetUserId: string): Promise<CreateDirectConversationResult>;
  createGroupConversation(currentUserId: string, input: CreateGroupConversationBody): Promise<GroupConversationDto>;
  listConversations(currentUserId: string, input: ListConversationsQuery): Promise<ListConversationsResult>;
  getConversation(currentUserId: string, conversationId: string): Promise<ConversationDto>;
  updateGroupTitle(currentUserId: string, conversationId: string, input: UpdateGroupTitleBody): Promise<GroupConversationDto>;
  addGroupMember(currentUserId: string, conversationId: string, input: AddGroupMemberBody): Promise<GroupMemberDto>;
  removeGroupMember(currentUserId: string, conversationId: string, userId: string): Promise<void>;
  leaveGroup(currentUserId: string, conversationId: string): Promise<void>;
  updateGroupMemberRole(currentUserId: string, conversationId: string, userId: string, input: UpdateGroupMemberRoleBody): Promise<GroupMemberDto>;
  transferGroupOwnership(currentUserId: string, conversationId: string, input: TransferGroupOwnershipBody): Promise<GroupConversationDto>;
}

export class ConversationController {
  constructor(private readonly conversationService: ConversationHttpService) {}

  readonly createDirect: ValidatedRequestHandler<CreateDirectConversationBody> = async (request, response, input) => {
    const result = await this.conversationService.getOrCreateDirectConversation(requireAuthContext(request).userId, input.userId);
    response.status(result.created ? 201 : 200).json(result.conversation);
  };

  readonly createGroup: ValidatedRequestHandler<CreateGroupConversationBody> = async (request, response, input) => {
    const conversation = await this.conversationService.createGroupConversation(requireAuthContext(request).userId, input);
    response.status(201).json(conversation);
  };

  readonly list: ValidatedRequestHandler<ListConversationsQuery> = async (request, response, input) => {
    const result = await this.conversationService.listConversations(requireAuthContext(request).userId, input);
    response.status(200).json(result);
  };

  readonly get: ValidatedRequestHandler<ConversationParams> = async (request, response, input) => {
    const conversation = await this.conversationService.getConversation(requireAuthContext(request).userId, input.conversationId);
    response.status(200).json(conversation);
  };

  readonly updateTitle: ValidatedRequestHandler<UpdateGroupTitleBody> = async (request, response, input) => {
    const conversation = await this.conversationService.updateGroupTitle(requireAuthContext(request).userId, requireConversationId(request.params.conversationId), input);
    response.status(200).json(conversation);
  };

  readonly addMember: ValidatedRequestHandler<AddGroupMemberBody> = async (request, response, input) => {
    const member = await this.conversationService.addGroupMember(requireAuthContext(request).userId, requireConversationId(request.params.conversationId), input);
    response.status(201).json(member);
  };

  readonly removeMember: ValidatedRequestHandler<GroupMemberParams> = async (request, response, input) => {
    await this.conversationService.removeGroupMember(requireAuthContext(request).userId, input.conversationId, input.userId);
    response.status(204).end();
  };

  readonly leave: ValidatedRequestHandler<ConversationParams> = async (request, response, input) => {
    await this.conversationService.leaveGroup(requireAuthContext(request).userId, input.conversationId);
    response.status(204).end();
  };

  readonly updateMemberRole: ValidatedRequestHandler<UpdateGroupMemberRoleBody> = async (request, response, input) => {
    const member = await this.conversationService.updateGroupMemberRole(
      requireAuthContext(request).userId,
      requireConversationId(request.params.conversationId),
      requireUserId(request.params.userId),
      input,
    );
    response.status(200).json(member);
  };

  readonly transferOwnership: ValidatedRequestHandler<TransferGroupOwnershipBody> = async (request, response, input) => {
    const conversation = await this.conversationService.transferGroupOwnership(requireAuthContext(request).userId, requireConversationId(request.params.conversationId), input);
    response.status(200).json(conversation);
  };
}

function requireConversationId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new Error("Validated conversationId is missing");
  return value;
}

function requireUserId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw new Error("Validated userId is missing");
  return value;
}
