import { conversationService } from "../conversations/conversation-core.js";
import { socketMessagePublisher } from "../../realtime/messages/message-publisher.js";
import { MessageController } from "./message.controller.js";
import { PrismaMessageRepository } from "./message.repository.js";
import { MessageService } from "./message.service.js";

export const messageRepository = new PrismaMessageRepository();
export const messageService = new MessageService(
  messageRepository,
  conversationService,
  socketMessagePublisher,
);
export const messageController = new MessageController(messageService);
