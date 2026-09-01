import {
  objectStorage,
  storageBuckets,
  storageSettings,
} from "../../infrastructure/storage/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logging/logger.js";
import { conversationService } from "../conversations/conversation-core.js";
import { AttachmentController } from "./attachment.controller.js";
import { SharpAttachmentImageProcessor } from "./attachment-image.processor.js";
import { PrismaAttachmentRepository } from "./attachment.repository.js";
import { AttachmentService } from "./attachment.service.js";
import { PdfJsAttachmentPdfProcessor } from "./attachment-pdf.processor.js";
import { ClamAvAttachmentScanner } from "./clamav-scanner.js";

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
  undefined,
  undefined,
  new PdfJsAttachmentPdfProcessor(),
  new ClamAvAttachmentScanner({
    host: env.CLAMAV_HOST,
    port: env.CLAMAV_PORT,
    timeoutMs: env.CLAMAV_SCAN_TIMEOUT_MS,
    maxConcurrentScans: env.CLAMAV_MAX_CONCURRENT_SCANS,
    streamMaxLengthBytes: env.CLAMAV_STREAM_MAX_LENGTH_BYTES,
  }),
  undefined,
  logger,
);
export const attachmentController = new AttachmentController(
  attachmentService,
);
