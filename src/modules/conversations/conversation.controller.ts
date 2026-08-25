import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/auth.middleware.js";
import type {
  ConversationParams,
  CreateDirectConversationBody,
  ListConversationsQuery,
} from "./conversation.schema.js";
import type {
  CreateDirectConversationResult,
  DirectConversationDto,
  ListConversationsResult,
} from "./conversation.service.js";

export interface ConversationHttpService {
  getOrCreateDirectConversation(
    currentUserId: string,
    targetUserId: string,
  ): Promise<CreateDirectConversationResult>;
  listConversations(
    currentUserId: string,
    input: ListConversationsQuery,
  ): Promise<ListConversationsResult>;
  getConversation(
    currentUserId: string,
    conversationId: string,
  ): Promise<DirectConversationDto>;
}

export class ConversationController {
  constructor(
    private readonly conversationService: ConversationHttpService,
  ) {}

  readonly createDirect: ValidatedRequestHandler<
    CreateDirectConversationBody
  > = async (request, response, input): Promise<void> => {
    const auth = requireAuthContext(request);
    const result =
      await this.conversationService.getOrCreateDirectConversation(
        auth.userId,
        input.userId,
      );

    response
      .status(result.created ? 201 : 200)
      .json(result.conversation);
  };

  readonly list: ValidatedRequestHandler<ListConversationsQuery> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const result = await this.conversationService.listConversations(
      auth.userId,
      input,
    );

    response.status(200).json(result);
  };

  readonly get: ValidatedRequestHandler<ConversationParams> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const conversation =
      await this.conversationService.getConversation(
        auth.userId,
        input.conversationId,
      );

    response.status(200).json(conversation);
  };
}
