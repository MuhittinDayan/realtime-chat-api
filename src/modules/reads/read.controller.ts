import type { Request } from "express";

import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/http/auth.middleware.js";
import type { UpdateReadWatermarkBody } from "./read.schema.js";
import type { ReadWatermarkDto } from "./read.service.js";

export interface ReadHttpService {
  updateWatermark(
    userId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<ReadWatermarkDto>;
}

export class ReadController {
  constructor(private readonly readService: ReadHttpService) {}

  readonly update: ValidatedRequestHandler<UpdateReadWatermarkBody> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.readService.updateWatermark(
      requireAuthContext(request).userId,
      readConversationId(request),
      input.throughMessageId,
    );

    response.status(200).json(result);
  };
}

function readConversationId(request: Request): string {
  const conversationId = request.params.conversationId;

  if (typeof conversationId !== "string") {
    throw new Error("Conversation route parameter is missing");
  }

  return conversationId;
}
