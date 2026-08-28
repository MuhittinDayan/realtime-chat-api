import type { RequestHandler } from "express";

import type { ValidatedRequestHandler } from "../../http/validation/request-validation.js";
import { requireAuthContext } from "../auth/auth.middleware.js";
import type {
  AvatarUploadParams,
  CreateAvatarUploadInput,
} from "./avatar.schema.js";
import type {
  AvatarService,
  AvatarUploadIntent,
} from "./avatar.service.js";

export interface AvatarHttpService {
  createUpload(
    ownerId: string,
    input: CreateAvatarUploadInput,
  ): Promise<AvatarUploadIntent>;
  completeUpload(ownerId: string, uploadId: string): ReturnType<AvatarService["completeUpload"]>;
  deleteAvatar(ownerId: string): ReturnType<AvatarService["deleteAvatar"]>;
}

export class AvatarController {
  constructor(private readonly avatarService: AvatarHttpService) {}

  readonly createUpload: ValidatedRequestHandler<CreateAvatarUploadInput> =
    async (request, response, input): Promise<void> => {
      const auth = requireAuthContext(request);
      const result = await this.avatarService.createUpload(auth.userId, input);

      response.setHeader("Cache-Control", "no-store");
      response.status(201).json(result);
    };

  readonly completeUpload: ValidatedRequestHandler<AvatarUploadParams> = async (
    request,
    response,
    params,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const user = await this.avatarService.completeUpload(
      auth.userId,
      params.uploadId,
    );

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ user });
  };

  readonly deleteAvatar: RequestHandler = async (
    request,
    response,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const user = await this.avatarService.deleteAvatar(auth.userId);

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ user });
  };
}
