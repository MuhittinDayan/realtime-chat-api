import { conversationService } from "../conversations/conversation-core.js";
import { socketMessagePublisher } from "../../realtime/messages/message-publisher.js";
import { socketNotificationPublisher } from "../../realtime/notifications/notification-publisher.js";
import { storageSettings } from "../../infrastructure/storage/index.js";
import { MessageController } from "./message.controller.js";
import { PrismaMessageRepository } from "./message.repository.js";
import { MessageService } from "./message.service.js";

export const messageRepository = new PrismaMessageRepository();
export const messageService = new MessageService(
  messageRepository,
  conversationService,
  socketMessagePublisher,
  undefined,
  storageSettings.deletedAttachmentRetentionMs,
  socketNotificationPublisher,
);
export const messageController = new MessageController(messageService);
