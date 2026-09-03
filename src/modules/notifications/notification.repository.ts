import type { PrismaClient } from "../../generated/prisma/client.js";
import type {
  MessageKind,
  NotificationType,
} from "../../generated/prisma/enums.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import type { NotificationListCursor } from "./notification.schema.js";

export interface NotificationSenderRecord {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface NotificationMessageRecord {
  id: string;
  kind: MessageKind;
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  sender: NotificationSenderRecord;
}

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  recipientUserId: string;
  conversationId: string;
  createdAt: Date;
  readAt: Date | null;
  message: NotificationMessageRecord;
}

export interface ListNotificationsRepositoryInput {
  recipientUserId: string;
  cursor?: NotificationListCursor;
  take: number;
}

export interface NotificationRepository {
  listNotifications(
    input: ListNotificationsRepositoryInput,
  ): Promise<readonly NotificationRecord[]>;
  countUnread(recipientUserId: string): Promise<number>;
  markRead(input: {
    notificationId: string;
    recipientUserId: string;
    readAt: Date;
  }): Promise<NotificationRecord | null>;
  markConversationRead(input: {
    conversationId: string;
    recipientUserId: string;
    readAt: Date;
  }): Promise<number>;
}

const notificationSelect = {
  id: true,
  type: true,
  recipientUserId: true,
  conversationId: true,
  createdAt: true,
  readAt: true,
  message: {
    select: {
      id: true,
      kind: true,
      body: true,
      createdAt: true,
      editedAt: true,
      deletedAt: true,
      sender: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  },
} as const;

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  listNotifications(
    input: ListNotificationsRepositoryInput,
  ): Promise<readonly NotificationRecord[]> {
    return this.client.notification.findMany({
      where: {
        recipientUserId: input.recipientUserId,
        ...(input.cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: input.cursor.createdAt } },
                {
                  createdAt: input.cursor.createdAt,
                  id: { lt: input.cursor.id },
                },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
      select: notificationSelect,
    });
  }

  countUnread(recipientUserId: string): Promise<number> {
    return this.client.notification.count({
      where: { recipientUserId, readAt: null },
    });
  }

  async markRead(input: {
    notificationId: string;
    recipientUserId: string;
    readAt: Date;
  }): Promise<NotificationRecord | null> {
    return this.client.$transaction(async (transaction) => {
      await transaction.notification.updateMany({
        where: {
          id: input.notificationId,
          recipientUserId: input.recipientUserId,
          readAt: null,
        },
        data: { readAt: input.readAt },
      });

      return transaction.notification.findFirst({
        where: {
          id: input.notificationId,
          recipientUserId: input.recipientUserId,
        },
        select: notificationSelect,
      });
    });
  }

  async markConversationRead(input: {
    conversationId: string;
    recipientUserId: string;
    readAt: Date;
  }): Promise<number> {
    const result = await this.client.notification.updateMany({
      where: {
        conversationId: input.conversationId,
        recipientUserId: input.recipientUserId,
        readAt: null,
      },
      data: { readAt: input.readAt },
    });
    return result.count;
  }
}
