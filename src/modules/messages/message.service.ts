import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import { encodeCursor } from "../../shared/pagination/cursor.js";
import { systemClock, type Clock } from "../../shared/time/clock.js";
import { MessageNotFoundError } from "./message.errors.js";
import type { MessageAttachmentDto } from "../attachments/application/attachment.service.ts";
import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PDF_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  type AttachmentContentType,
} from "../attachments/domain/attachment.constants.ts";
import type {
  MessageRecord,
  MessageRepository,
} from "./message.repository.js";
import type {
  CreateMessageBody,
  MessageHistoryQuery,
  UpdateMessageBody,
} from "./message.schema.js";

export interface BaseMessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: "TEXT" | "MEDIA";
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface TextMessageDto extends BaseMessageDto {
  kind: "TEXT";
}

export interface MediaMessageDto extends BaseMessageDto {
  kind: "MEDIA";
  attachments: readonly MessageAttachmentDto[];
}

export type MessageDto = TextMessageDto | MediaMessageDto;

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
  publishMessageUpdated(message: MessageDto): Promise<void> | void;
  publishMessageDeleted(message: MessageDto): Promise<void> | void;
}

export class MessageService {
  constructor(
    private readonly messageRepository: MessageRepository,
    private readonly conversationAccessService: ConversationAccessService,
    private readonly messagePublisher: MessagePublisher,
    private readonly clock: Clock = systemClock,
    private readonly deletedAttachmentRetentionMs = 2_592_000_000,
  ) { }

  async createMessage(
    userId: string,
    conversationId: string,
    input: CreateMessageBody,
  ): Promise<CreateMessageResult> {
    await this.ensureActiveMember(conversationId, userId);
    const repositoryInput =
      input.content.type === "media"
        ? {
          conversationId,
          senderId: userId,
          clientMessageId: input.clientMessageId,
          kind: "MEDIA" as const,
          body: input.content.text ?? null,
          attachmentIds: input.content.attachmentIds,
        }
        : {
          conversationId,
          senderId: userId,
          clientMessageId: input.clientMessageId,
          kind: "TEXT" as const,
          body: input.content.text,
          attachmentIds: [],
        };
    const result = await this.messageRepository.createMessage(repositoryInput);
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

  async updateMessage(
    userId: string,
    conversationId: string,
    messageId: string,
    input: UpdateMessageBody,
  ): Promise<MessageDto> {
    await this.ensureActiveMember(conversationId, userId);
    const result = await this.messageRepository.updateMessage({
      conversationId,
      messageId,
      senderId: userId,
      kind: input.content.type === "media" ? "MEDIA" : "TEXT",
      body: input.content.text,
      editedAt: this.clock.now(),
    });

    if (result.message === null) {
      throw new MessageNotFoundError();
    }

    const message = toMessageDto(result.message);

    if (result.changed) {
      await this.messagePublisher.publishMessageUpdated(message);
    }

    return message;
  }

  async deleteMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MessageDto> {
    await this.ensureActiveMember(conversationId, userId);
    const deletedAt = this.clock.now();
    const result = await this.messageRepository.softDeleteMessage({
      conversationId,
      messageId,
      senderId: userId,
      deletedAt,
      attachmentPurgeAfter: new Date(
        deletedAt.getTime() + this.deletedAttachmentRetentionMs,
      ),
    });

    if (result.message === null) {
      throw new MessageNotFoundError();
    }

    const message = toMessageDto(result.message);

    if (result.changed) {
      await this.messagePublisher.publishMessageDeleted(message);
    }

    return message;
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
  const base = {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    clientMessageId: message.clientMessageId,
    kind: message.kind,
    body: message.deletedAt === null ? message.body : null,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
  };

  if (message.kind === "TEXT") {
    if (message.body === null) {
      throw new Error("Text message body is missing");
    }

    return { ...base, kind: "TEXT" };
  }

  return {
    ...base,
    kind: "MEDIA",
    attachments:
      message.deletedAt === null
        ? message.attachments.map(toMessageAttachmentDto)
        : [],
  };
}

function toMessageAttachmentDto(
  attachment: MessageRecord["attachments"][number],
): MessageAttachmentDto {
  if (attachment.readyObjectKey === null) {
    throw new Error("Ready message attachment metadata is incomplete");
  }

  const basePath =
    `/api/v1/conversations/${attachment.conversationId}` +
    `/attachments/${attachment.id}`;

  const kind = attachment.kind;

  switch (kind) {
    case "IMAGE":
      if (
        attachment.width === null ||
        attachment.height === null ||
        attachment.thumbnailObjectKey === null
      ) {
        throw new Error("Ready image attachment metadata is incomplete");
      }

      return {
        id: attachment.id,
        kind: "IMAGE",
        originalFileName: attachment.originalFileName,
        contentType: "image/webp",
        width: attachment.width,
        height: attachment.height,
        url: `${basePath}/original`,
        thumbnailUrl: `${basePath}/thumbnail`,
      };
    case "PDF":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_PDF_CONTENT_TYPE,
        "PDF",
      );
      return {
        id: attachment.id,
        kind: "PDF",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_PDF_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "DOCX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_DOCX_CONTENT_TYPE,
        "DOCX",
      );
      return {
        id: attachment.id,
        kind: "DOCX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_DOCX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "XLSX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_XLSX_CONTENT_TYPE,
        "XLSX",
      );
      return {
        id: attachment.id,
        kind: "XLSX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_XLSX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    case "PPTX":
      requireDetectedContentType(
        attachment.detectedContentType,
        ATTACHMENT_PPTX_CONTENT_TYPE,
        "PPTX",
      );
      return {
        id: attachment.id,
        kind: "PPTX",
        originalFileName: attachment.originalFileName,
        contentType: ATTACHMENT_PPTX_CONTENT_TYPE,
        url: `${basePath}/original`,
      };
    default:
      return assertNever(kind);
  }
}

function requireDetectedContentType(
  actual: string | null,
  expected: AttachmentContentType,
  kind: string,
): void {
  if (actual !== expected) {
    throw new Error(`Ready ${kind} attachment metadata is incomplete`);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported attachment kind: ${String(value)}`);
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
