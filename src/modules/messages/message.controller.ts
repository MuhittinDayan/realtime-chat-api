import type { Request } from "express";

import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/auth.middleware.js";
import type {
  CreateMessageBody,
  MessageHistoryQuery,
} from "./message.schema.js";
import type {
  CreateMessageResult,
  MessageHistoryResult,
} from "./message.service.js";

export interface MessageHttpService {
  createMessage(
    userId: string,
    conversationId: string,
    input: CreateMessageBody,
  ): Promise<CreateMessageResult>;
  listMessages(
    userId: string,
    conversationId: string,
    input: MessageHistoryQuery,
  ): Promise<MessageHistoryResult>;
}

export class MessageController {
  constructor(private readonly messageService: MessageHttpService) {}

  readonly create: ValidatedRequestHandler<CreateMessageBody> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.messageService.createMessage(
      requireAuthContext(request).userId,
      readConversationId(request),
      input,
    );

    response.status(result.created ? 201 : 200).json(result.message);
  };

  readonly list: ValidatedRequestHandler<MessageHistoryQuery> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.messageService.listMessages(
      requireAuthContext(request).userId,
      readConversationId(request),
      input,
    );

    response.status(200).json(result);
  };
}

function readConversationId(request: Request): string {
  const conversationId = request.params.conversationId;

  if (typeof conversationId !== "string") {
    throw new Error("Conversation route parameter is missing");
  }

  return conversationId;
}
