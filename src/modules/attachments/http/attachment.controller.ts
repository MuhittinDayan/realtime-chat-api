import type { ValidatedRequestHandler } from "../../../http/validation/request-validation.ts";
import { requireAuthContext } from "../../auth/auth.middleware.ts";
import type {
  AttachmentAccessParams,
  AttachmentUploadParams,
  CreateAttachmentUploadInput,
} from "./attachment.schema.ts";
import type {
  AttachmentService,
  AttachmentUploadIntent,
  MessageAttachmentDto,
} from "../application/attachment.service.ts";

export interface AttachmentHttpService {
  createUpload(
    ownerId: string,
    conversationId: string,
    input: CreateAttachmentUploadInput,
  ): Promise<AttachmentUploadIntent>;
  completeUpload(
    ownerId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<MessageAttachmentDto>;
  createAccess(
    userId: string,
    conversationId: string,
    attachmentId: string,
    variant: "original" | "thumbnail",
  ): ReturnType<AttachmentService["createAccess"]>;
}

export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentHttpService) { }

  readonly createUpload: ValidatedRequestHandler<CreateAttachmentUploadInput> =
    async (request, response, input): Promise<void> => {
      const auth = requireAuthContext(request);
      const conversationId = readConversationId(request.params.conversationId);
      const result = await this.attachmentService.createUpload(
        auth.userId,
        conversationId,
        input,
      );

      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(result);
    };

  readonly completeUpload: ValidatedRequestHandler<AttachmentUploadParams> =
    async (request, response, params): Promise<void> => {
      const auth = requireAuthContext(request);
      const attachment = await this.attachmentService.completeUpload(
        auth.userId,
        params.conversationId,
        params.attachmentId,
      );

      response.setHeader("Cache-Control", "no-store");
      response.status(200).json({ attachment });
    };

  readonly access: ValidatedRequestHandler<AttachmentAccessParams> = async (
    request,
    response,
    params,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const access = await this.attachmentService.createAccess(
      auth.userId,
      params.conversationId,
      params.attachmentId,
      params.variant,
    );

    response.setHeader("Cache-Control", "no-store");
    response.redirect(307, access.url);
  };
}

function readConversationId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Conversation route parameter is missing");
  }

  return value;
}
