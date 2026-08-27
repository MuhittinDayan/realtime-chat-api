import type { Request } from "express";

import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/auth.middleware.js";
import type {
  CreateMessageBody,
  MessageParams,
  MessageHistoryQuery,
  UpdateMessageBody,
} from "./message.schema.js";
import type {
  CreateMessageResult,
  MessageDto,
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
  updateMessage(
    userId: string,
    conversationId: string,
    messageId: string,
    input: UpdateMessageBody,
  ): Promise<MessageDto>;
  deleteMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MessageDto>;
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

  readonly update: ValidatedRequestHandler<UpdateMessageBody> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const message = await this.messageService.updateMessage(
      requireAuthContext(request).userId,
      readConversationId(request),
      readMessageId(request),
      input,
    );

    response.status(200).json(message);
  };

  readonly delete: ValidatedRequestHandler<MessageParams> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const message = await this.messageService.deleteMessage(
      requireAuthContext(request).userId,
      input.conversationId,
      input.messageId,
    );

    response.status(200).json(message);
  };
}

function readConversationId(request: Request): string {
  const conversationId = request.params.conversationId;

  if (typeof conversationId !== "string") {
    throw new Error("Conversation route parameter is missing");
  }

  return conversationId;
}

function readMessageId(request: Request): string {
  const messageId = request.params.messageId;

  if (typeof messageId !== "string") {
    throw new Error("Message route parameter is missing");
  }

  return messageId;
}
