import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import type { ConversationAccessService } from "../messages/message.service.js";
import { encodeCursor } from "../../shared/pagination/cursor.js";
import { logger } from "../../shared/logging/logger.js";
import { systemClock, type Clock } from "../../shared/time/clock.js";
import {
  noopNotificationPublisher,
  type NotificationPublisher,
} from "./notification.events.js";
import { NotificationNotFoundError } from "./notification.errors.js";
import type {
  NotificationRecord,
  NotificationRepository,
} from "./notification.repository.js";
import type { ListNotificationsQuery } from "./notification.schema.js";

export interface NotificationDto {
  id: string;
  type: "MESSAGE_CREATED";
  conversationId: string;
  createdAt: Date;
  readAt: Date | null;
  message: {
    id: string;
    kind: "TEXT" | "MEDIA";
    body: string | null;
    createdAt: Date;
    editedAt: Date | null;
    deletedAt: Date | null;
    sender: {
      id: string;
      username: string;
      displayName: string;
      avatarUrl: string | null;
    };
  };
}

export interface ListNotificationsResult {
  items: readonly NotificationDto[];
  nextCursor: string | null;
}

export interface NotificationUnreadCountResult {
  unreadCount: number;
}

export interface MarkConversationNotificationsReadResult {
  markedCount: number;
}

export class NotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly conversationAccessService: ConversationAccessService,
    private readonly clock: Clock = systemClock,
    private readonly notificationPublisher: NotificationPublisher =
      noopNotificationPublisher,
  ) {}

  async listNotifications(
    currentUserId: string,
    input: ListNotificationsQuery,
  ): Promise<ListNotificationsResult> {
    const records = await this.notificationRepository.listNotifications({
      recipientUserId: currentUserId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      take: input.limit + 1,
    });
    const hasNextPage = records.length > input.limit;
    const page = records.slice(0, input.limit);

    return {
      items: page.map(toNotificationDto),
      nextCursor: hasNextPage ? createNextCursor(page.at(-1)) : null,
    };
  }

  async getUnreadCount(
    currentUserId: string,
  ): Promise<NotificationUnreadCountResult> {
    return {
      unreadCount:
        await this.notificationRepository.countUnread(currentUserId),
    };
  }

  async markRead(
    currentUserId: string,
    notificationId: string,
  ): Promise<NotificationDto> {
    const readAt = this.clock.now();
    const notification = await this.notificationRepository.markRead({
      notificationId,
      recipientUserId: currentUserId,
      readAt,
    });

    if (notification === null) {
      throw new NotificationNotFoundError();
    }

    await this.publishBestEffort(
      () =>
        this.notificationPublisher.publishRead({
          id: notification.id,
          recipientUserId: currentUserId,
          readAt: notification.readAt ?? readAt,
        }),
      { notificationId: notification.id },
      "Notification read event publish failed",
    );

    return toNotificationDto(notification);
  }

  async markConversationRead(
    currentUserId: string,
    conversationId: string,
  ): Promise<MarkConversationNotificationsReadResult> {
    if (
      !(await this.conversationAccessService.isActiveMember(
        conversationId,
        currentUserId,
      ))
    ) {
      throw new ConversationNotFoundError();
    }

    const markedCount = await this.notificationRepository.markConversationRead(
      {
        conversationId,
        recipientUserId: currentUserId,
        readAt: this.clock.now(),
      },
    );

    await this.publishBestEffort(
      () =>
        this.notificationPublisher.publishConversationRead({
          recipientUserId: currentUserId,
          conversationId,
          markedCount,
        }),
      { conversationId },
      "Conversation notifications read event publish failed",
    );

    return { markedCount };
  }

  private async publishBestEffort(
    publish: () => Promise<void> | void,
    context: object,
    message: string,
  ): Promise<void> {
    try {
      await publish();
    } catch (error: unknown) {
      logger.error({ err: error, ...context }, message);
    }
  }
}

function toNotificationDto(notification: NotificationRecord): NotificationDto {
  return {
    id: notification.id,
    type: notification.type,
    conversationId: notification.conversationId,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
    message: {
      ...notification.message,
      body:
        notification.message.deletedAt === null
          ? notification.message.body
          : null,
    },
  };
}

function createNextCursor(
  notification: NotificationRecord | undefined,
): string | null {
  if (notification === undefined) {
    return null;
  }

  return encodeCursor({
    v: 1,
    createdAt: notification.createdAt.toISOString(),
    id: notification.id,
  });
}
