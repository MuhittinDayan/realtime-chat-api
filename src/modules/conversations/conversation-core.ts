import { ConversationController } from "./conversation.controller.js";
import { PrismaConversationRepository } from "./conversation.repository.js";
import { ConversationService } from "./conversation.service.js";

export const conversationRepository = new PrismaConversationRepository();
export const conversationService = new ConversationService(
  conversationRepository,
);
export const conversationController = new ConversationController(
  conversationService,
);
