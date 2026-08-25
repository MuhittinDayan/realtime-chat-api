import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { encodeCursor } from "../../shared/pagination/cursor.js";
import type {
  MessageRecord,
  MessageRepository,
} from "./message.repository.js";
import type {
  CreateMessageBody,
  MessageHistoryQuery,
} from "./message.schema.js";

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: "TEXT";
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

export interface CreateMessageResult {
  message: MessageDto;
  created: boolean;
}

export interface MessageHistoryResult {
  items: readonly MessageDto[];
  nextCursor: string | null;
}

export interface ConversationAccessService {
  isActiveMember(conversationId: string, userId: string): Promise<boolean>;
}

export interface MessagePublisher {
  publishMessageCreated(message: MessageDto): Promise<void> | void;
}

export class MessageService {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly conversationAccessService: ConversationAccessService,
    private readonly messagePublisher: MessagePublisher,
  ) {}

  async createMessage(
    userId: string,
    conversationId: string,
    input: CreateMessageBody,
  ): Promise<CreateMessageResult> {
    await this.ensureActiveMember(conversationId, userId);
    const result = await this.messageRepository.createMessage({
      conversationId,
      senderId: userId,
      clientMessageId: input.clientMessageId,
      body: input.content.text,
    });
    const message = toMessageDto(result.message);

    if (result.created) {
      await this.messagePublisher.publishMessageCreated(message);
    }

    return { message, created: result.created };
  }

  async listMessages(
    userId: string,
    conversationId: string,
    input: MessageHistoryQuery,
  ): Promise<MessageHistoryResult> {
    await this.ensureActiveMember(conversationId, userId);
    const records = await this.messageRepository.listMessages({
      conversationId,
      ...(input.before === undefined ? {} : { before: input.before }),
      take: input.limit + 1,
    });
    const hasNextPage = records.length > input.limit;
    const descendingPage = records.slice(0, input.limit);
    const oldest = descendingPage.at(-1);

    return {
      items: descendingPage.toReversed().map(toMessageDto),
      nextCursor: hasNextPage ? createNextCursor(oldest) : null,
    };
  }

  private async ensureActiveMember(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    if (
      !(await this.conversationAccessService.isActiveMember(
        conversationId,
        userId,
      ))
    ) {
      throw new ConversationNotFoundError();
    }
  }
}

function toMessageDto(message: MessageRecord): MessageDto {
  if (message.kind !== "TEXT") {
    throw new Error("Unsupported message kind");
  }

  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    body: message.body,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
  };
}

function createNextCursor(message: MessageRecord | undefined): string {
  if (message === undefined) {
    throw new Error("Cannot create a cursor for an empty page");
  }

  return encodeCursor({
    v: 1,
    createdAt: message.createdAt.toISOString(),
    id: message.id,
  });
}
