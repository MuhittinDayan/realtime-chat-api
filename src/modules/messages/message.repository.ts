import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import type { MessageKind } from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { MessageHistoryCursor } from "./message.schema.js";

export interface MessageRecord {
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: MessageKind;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

export interface CreateMessageRepositoryInput {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  body: string;
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
  body: string;
  editedAt: Date;
}

export interface SoftDeleteMessageRepositoryInput {
  conversationId: string;
  messageId: string;
  senderId: string;
  deletedAt: Date;
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
} as const;

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
  constructor(private readonly client: PrismaClient = prisma) {}

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
          const created = await transaction.message.create({
            data: {
              conversationId: input.conversationId,
              senderId: input.senderId,
              clientMessageId: input.clientMessageId,
              kind: "TEXT",
              body: input.body,
            },
            select: messageSelect,
          });

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

          return created;
        },
      );

      return { message, created: true };
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
    return this.client.message.findMany({
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
          deletedAt: null,
        },
        select: messageSelect,
      });

      return { message, changed: mutation.count > 0 };
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
      const message = await transaction.message.findFirst({
        where: {
          id: input.messageId,
          conversationId: input.conversationId,
          senderId: input.senderId,
        },
        select: messageSelect,
      });

      return { message, changed: mutation.count > 0 };
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
    });
  }
}
