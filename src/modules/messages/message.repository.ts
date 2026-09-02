import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import type { MessageKind } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import {
  AttachmentBindingError,
  MessageAttachmentsTotalSizeExceededError,
} from "../attachments/domain/attachment.errors.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES,
} from "../attachments/domain/attachment.constants.ts";
import type { AttachmentKind } from "../attachments/domain/attachment.constants.ts";
import type { MessageHistoryCursor } from "./message.schema.js";

export interface MessageAttachmentRecord {
  id: string;
  conversationId: string;
  originalFileName: string;
  kind: AttachmentKind;
  position: number;
  actualSize: number | null;
  detectedContentType: string | null;
  width: number | null;
  height: number | null;
  readyObjectKey: string | null;
  thumbnailObjectKey: string | null;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: MessageKind;
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  attachments: readonly MessageAttachmentRecord[];
}

export interface CreateMessageRepositoryInput {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: "TEXT" | "MEDIA";
  body: string | null;
  attachmentIds: readonly string[];
}

export interface CreateMessageRepositoryResult {
  message: MessageRecord;
  created: boolean;
}

export interface ListMessagesRepositoryInput {
  conversationId: string;
  before?: MessageHistoryCursor;
  take: number;
}

export interface UpdateMessageRepositoryInput {
  conversationId: string;
  messageId: string;
  senderId: string;
  kind: "TEXT" | "MEDIA";
  body: string | null;
  editedAt: Date;
}

export interface SoftDeleteMessageRepositoryInput {
  conversationId: string;
  messageId: string;
  senderId: string;
  deletedAt: Date;
  attachmentPurgeAfter: Date;
}

export interface MessageMutationRepositoryResult {
  message: MessageRecord | null;
  changed: boolean;
}

export interface MessageRepository {
  createMessage(
    input: CreateMessageRepositoryInput,
  ): Promise<CreateMessageRepositoryResult>;
  listMessages(
    input: ListMessagesRepositoryInput,
  ): Promise<readonly MessageRecord[]>;
  updateMessage(
    input: UpdateMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult>;
  softDeleteMessage(
    input: SoftDeleteMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult>;
}

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  kind: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  attachments: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      conversationId: true,
      originalFileName: true,
      kind: true,
      position: true,
      thumbnailObjectKey: true,
      asset: {
        select: {
          detectedContentType: true,
          actualSize: true,
          width: true,
          height: true,
          readyObjectKey: true,
        },
      },
    },
  },
} as const;

type SelectedMessage = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;

function toMessageRecord(message: SelectedMessage): MessageRecord {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      conversationId: attachment.conversationId,
      originalFileName: attachment.originalFileName,
      kind: attachment.kind,
      position: attachment.position,
      thumbnailObjectKey: attachment.thumbnailObjectKey,
      detectedContentType: attachment.asset.detectedContentType,
      actualSize: attachment.asset.actualSize,
      width: attachment.asset.width,
      height: attachment.asset.height,
      readyObjectKey: attachment.asset.readyObjectKey,
    })),
  };
}

function isMessageIdempotencyConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return false;
  }

  try {
    const metadata = JSON.stringify(error.meta ?? {}).toLowerCase();
    return metadata.includes("sender") && metadata.includes("client");
  } catch {
    return false;
  }
}

export class PrismaMessageRepository implements MessageRepository {
  constructor(private readonly client: PrismaClient = prisma) { }

  async createMessage(
    input: CreateMessageRepositoryInput,
  ): Promise<CreateMessageRepositoryResult> {
    const existing = await this.findByIdempotencyKey(
      input.senderId,
      input.clientMessageId,
    );

    if (existing !== null) {
      return { message: existing, created: false };
    }

    try {
      const message = await this.client.$transaction(
        async (transaction) => {
          if (input.kind === "MEDIA") {
            if (
              input.attachmentIds.length < 1 ||
              input.attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE ||
              new Set(input.attachmentIds).size !== input.attachmentIds.length
            ) {
              throw new AttachmentBindingError();
            }

            const membership = await transaction.conversationMember.findUnique({
              where: {
                conversationId_userId: {
                  conversationId: input.conversationId,
                  userId: input.senderId,
                },
              },
              select: { leftAt: true },
            });

            if (membership === null || membership.leftAt !== null) {
              throw new ConversationNotFoundError();
            }

            const availableAttachments =
              await transaction.messageAttachment.findMany({
                where: {
                  id: { in: [...input.attachmentIds] },
                  conversationId: input.conversationId,
                  messageId: null,
                  asset: {
                    ownerId: input.senderId,
                    purpose: "MESSAGE_ATTACHMENT",
                    status: "READY",
                  },
                },
                select: {
                  id: true,
                  asset: { select: { actualSize: true } },
                },
              });

            if (availableAttachments.length !== input.attachmentIds.length) {
              throw new AttachmentBindingError();
            }

            const actualSizes = availableAttachments.map(
              (attachment) => attachment.asset.actualSize,
            );

            if (actualSizes.some((size) => size === null)) {
              throw new AttachmentBindingError();
            }

            const totalSize = actualSizes.reduce<number>(
              (total, size) => total + (size ?? 0),
              0,
            );

            if (totalSize > MAX_MESSAGE_ATTACHMENTS_TOTAL_BYTES) {
              throw new MessageAttachmentsTotalSizeExceededError();
            }
          }

          const created = await transaction.message.create({
            data: {
              conversationId: input.conversationId,
              senderId: input.senderId,
              clientMessageId: input.clientMessageId,
              kind: input.kind,
              body: input.body,
            },
            select: messageSelect,
          });

          if (input.kind === "MEDIA") {
            for (const [position, attachmentId] of input.attachmentIds.entries()) {
              const bound = await transaction.messageAttachment.updateMany({
                where: {
                  id: attachmentId,
                  conversationId: input.conversationId,
                  messageId: null,
                },
                data: { messageId: created.id, position },
              });

              if (bound.count !== 1) {
                throw new AttachmentBindingError();
              }
            }
          }

          await transaction.conversation.updateMany({
            where: {
              id: input.conversationId,
              OR: [
                { lastMessageAt: null },
                { lastMessageAt: { lt: created.createdAt } },
              ],
            },
            data: { lastMessageAt: created.createdAt },
          });

          if (input.kind === "TEXT") {
            return created;
          }

          return transaction.message.findUniqueOrThrow({
            where: { id: created.id },
            select: messageSelect,
          });
        },
      );

      return { message: toMessageRecord(message), created: true };
    } catch (error: unknown) {
      if (!isMessageIdempotencyConflict(error)) {
        throw error;
      }

      const racedMessage = await this.findByIdempotencyKey(
        input.senderId,
        input.clientMessageId,
      );

      if (racedMessage === null) {
        throw error;
      }

      return { message: racedMessage, created: false };
    }
  }

  async listMessages(
    input: ListMessagesRepositoryInput,
  ): Promise<readonly MessageRecord[]> {
    const messages = await this.client.message.findMany({
      where: {
        conversationId: input.conversationId,
        ...(input.before === undefined
          ? {}
          : {
            OR: [
              { createdAt: { lt: input.before.createdAt } },
              {
                createdAt: input.before.createdAt,
                id: { lt: input.before.id },
              },
            ],
          }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
      select: messageSelect,
    });

    return messages.map(toMessageRecord);
  }

  async updateMessage(
    input: UpdateMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      const mutation = await transaction.message.updateMany({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          senderId: input.senderId,
          kind: input.kind,
          deletedAt: null,
          body: { not: input.body },
        },
        data: {
          body: input.body,
          editedAt: input.editedAt,
        },
      });
      const message = await transaction.message.findFirst({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          senderId: input.senderId,
          kind: input.kind,
          deletedAt: null,
        },
        select: messageSelect,
      });

      return {
        message: message === null ? null : toMessageRecord(message),
        changed: mutation.count > 0,
      };
    });
  }

  async softDeleteMessage(
    input: SoftDeleteMessageRepositoryInput,
  ): Promise<MessageMutationRepositoryResult> {
    return this.client.$transaction(async (transaction) => {
      const mutation = await transaction.message.updateMany({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          senderId: input.senderId,
          deletedAt: null,
        },
        data: { deletedAt: input.deletedAt },
      });
      if (mutation.count > 0) {
        await transaction.messageAttachment.updateMany({
          where: { messageId: input.messageId },
          data: { purgeAfter: input.attachmentPurgeAfter },
        });
      }
      const message = await transaction.message.findFirst({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          senderId: input.senderId,
        },
        select: messageSelect,
      });

      return {
        message: message === null ? null : toMessageRecord(message),
        changed: mutation.count > 0,
      };
    });
  }

  private findByIdempotencyKey(
    senderId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    return this.client.message.findUnique({
      where: {
        senderId_clientMessageId: { senderId, clientMessageId },
      },
      select: messageSelect,
    }).then((message) =>
      message === null ? null : toMessageRecord(message),
    );
  }
}
