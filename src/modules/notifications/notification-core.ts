import { conversationService } from "../conversations/conversation-core.js";
import { socketNotificationPublisher } from "../../realtime/notifications/notification-publisher.js";
import { NotificationController } from "./notification.controller.js";
import { PrismaNotificationRepository } from "./notification.repository.js";
import { NotificationService } from "./notification.service.js";

export const notificationRepository = new PrismaNotificationRepository();
export const notificationService = new NotificationService(
  notificationRepository,
  conversationService,
  undefined,
  socketNotificationPublisher,
);
export const notificationController = new NotificationController(
  notificationService,
);
