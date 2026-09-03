import type { RequestHandler } from "express";

import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/http/auth.middleware.js";
import type {
  ListNotificationsQuery,
  NotificationParams,
} from "./notification.schema.js";
import type {
  ListNotificationsResult,
  MarkConversationNotificationsReadResult,
  NotificationDto,
  NotificationUnreadCountResult,
} from "./notification.service.js";

export interface NotificationHttpService {
  listNotifications(
    currentUserId: string,
    input: ListNotificationsQuery,
  ): Promise<ListNotificationsResult>;
  getUnreadCount(currentUserId: string): Promise<NotificationUnreadCountResult>;
  markRead(
    currentUserId: string,
    notificationId: string,
  ): Promise<NotificationDto>;
  markConversationRead(
    currentUserId: string,
    conversationId: string,
  ): Promise<MarkConversationNotificationsReadResult>;
}

export class NotificationController {
  constructor(private readonly notificationService: NotificationHttpService) {}

  readonly list: ValidatedRequestHandler<ListNotificationsQuery> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    response.status(200).json(
      await this.notificationService.listNotifications(
        requireAuthContext(request).userId,
        input,
      ),
    );
  };

  readonly unreadCount: RequestHandler = async (
    request,
    response,
  ): Promise<void> => {
    response.status(200).json(
      await this.notificationService.getUnreadCount(
        requireAuthContext(request).userId,
      ),
    );
  };

  readonly markRead: ValidatedRequestHandler<NotificationParams> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    response.status(200).json(
      await this.notificationService.markRead(
        requireAuthContext(request).userId,
        input.notificationId,
      ),
    );
  };

  readonly markConversationRead: ValidatedRequestHandler<{
    conversationId: string;
  }> = async (request, response, input): Promise<void> => {
    response.status(200).json(
      await this.notificationService.markConversationRead(
        requireAuthContext(request).userId,
        input.conversationId,
      ),
    );
  };
}
