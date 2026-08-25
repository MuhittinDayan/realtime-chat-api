import { RequestValidationError } from "../../shared/errors/request-validation-error.js";
import { ConversationNotFoundError } from "../conversations/conversation.errors.js";
import type { ConversationAccessService } from "../messages/message.service.js";
import type { ReadRepository } from "./read.repository.js";

export type ReadWatermarkStatus = "created" | "advanced" | "unchanged";

export interface ReadWatermarkDto {
  conversationId: string;
  throughMessageId: string;
  readAt: Date;
  status: ReadWatermarkStatus;
}

export interface ReadUpdatedEvent {
  conversationId: string;
  readerId: string;
  throughMessageId: string;
  readAt: Date;
}

export interface ReadPublisher {
  publishReadUpdated(event: ReadUpdatedEvent): Promise<void> | void;
}

export class ReadService {
  constructor(
    private readonly readRepository: ReadRepository,
    private readonly conversationAccessService: ConversationAccessService,
    private readonly readPublisher: ReadPublisher,
  ) {}

  async updateWatermark(
    userId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<ReadWatermarkDto> {
    if (
      !(await this.conversationAccessService.isActiveMember(
        conversationId,
        userId,
      ))
    ) {
      throw new ConversationNotFoundError();
    }

    const mutation = await this.readRepository.updateWatermark({
      conversationId,
      userId,
      throughMessageId,
    });

    if (!mutation.targetExists) {
      throw new RequestValidationError([
        {
          path: "body.throughMessageId",
          message: "Message does not belong to this conversation",
        },
      ]);
    }

    if (
      mutation.currentMessageId === null ||
      mutation.currentReadAt === null
    ) {
      throw new Error("Read watermark mutation produced an invalid state");
    }

    const status = determineStatus(
      mutation.previousMessageId,
      mutation.currentMessageId,
    );
    const result: ReadWatermarkDto = {
      conversationId,
      throughMessageId: mutation.currentMessageId,
      readAt: mutation.currentReadAt,
      status,
    };

    if (status !== "unchanged") {
      await this.readPublisher.publishReadUpdated({
        conversationId,
        readerId: userId,
        throughMessageId: mutation.currentMessageId,
        readAt: mutation.currentReadAt,
      });
    }

    return result;
  }
}

function determineStatus(
  previousMessageId: string | null,
  currentMessageId: string,
): ReadWatermarkStatus {
  if (previousMessageId === null) {
    return "created";
  }

  return previousMessageId === currentMessageId ? "unchanged" : "advanced";
}
