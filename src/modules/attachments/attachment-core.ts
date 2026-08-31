import {
  objectStorage,
  storageBuckets,
  storageSettings,
} from "../../infrastructure/storage/index.js";
import { conversationService } from "../conversations/conversation-core.js";
import { AttachmentController } from "./attachment.controller.js";
import { SharpAttachmentImageProcessor } from "./attachment-image.processor.js";
import { PrismaAttachmentRepository } from "./attachment.repository.js";
import { AttachmentService } from "./attachment.service.js";

export const attachmentRepository = new PrismaAttachmentRepository();
export const attachmentService = new AttachmentService(
  attachmentRepository,
  objectStorage,
  new SharpAttachmentImageProcessor(),
  conversationService,
  {
    attachmentBucket: storageBuckets.attachment,
    uploadUrlTtlSeconds: storageSettings.avatarUploadUrlTtlSeconds,
    downloadUrlTtlSeconds:
      storageSettings.attachmentDownloadUrlTtlSeconds,
  },
);
export const attachmentController = new AttachmentController(
  attachmentService,
);
