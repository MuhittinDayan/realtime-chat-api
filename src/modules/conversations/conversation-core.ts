import { ConversationController } from "./conversation.controller.js";
import { PrismaConversationRepository } from "./conversation.repository.js";
import { ConversationService } from "./conversation.service.js";
import { socketGroupPublisher } from "../../realtime/groups/group-publisher.js";

export const conversationRepository = new PrismaConversationRepository();
export const conversationService = new ConversationService(
  conversationRepository,
  socketGroupPublisher,
);
export const conversationController = new ConversationController(
  conversationService,
);
