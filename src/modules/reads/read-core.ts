import { conversationService } from "../conversations/conversation-core.js";
import { socketReadPublisher } from "../../realtime/reads/read-publisher.js";
import { ReadController } from "./read.controller.js";
import { PrismaReadRepository } from "./read.repository.js";
import { ReadService } from "./read.service.js";

export const readRepository = new PrismaReadRepository();
export const readService = new ReadService(
  readRepository,
  conversationService,
  socketReadPublisher,
);
export const readController = new ReadController(readService);
