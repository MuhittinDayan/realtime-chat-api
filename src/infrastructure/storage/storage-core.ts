import { env } from "../../config/env.js";
import { createS3Client, S3ObjectStorage } from "./s3-object-storage.js";

const clientConfig = {
  region: env.STORAGE_REGION,
  accessKeyId: env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
  ...(env.STORAGE_ENDPOINT === undefined
    ? {}
    : { endpoint: env.STORAGE_ENDPOINT }),
};

export const storageBuckets = Object.freeze({
  avatar: env.STORAGE_AVATAR_BUCKET,
  attachment: env.STORAGE_ATTACHMENT_BUCKET,
});

export const storageSettings = Object.freeze({
  publicAvatarBaseUrl: env.STORAGE_PUBLIC_BASE_URL,
  avatarUploadUrlTtlSeconds: env.AVATAR_UPLOAD_URL_TTL_SECONDS,
  attachmentDownloadUrlTtlSeconds:
    env.ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS,
  cleanupIntervalMs: env.MEDIA_CLEANUP_INTERVAL_MS,
  staleUploadAgeMs: env.MEDIA_STALE_UPLOAD_AGE_MS,
  unboundAttachmentAgeMs: env.MEDIA_UNBOUND_ATTACHMENT_AGE_MS,
  deletedAttachmentRetentionMs:
    env.MEDIA_DELETED_ATTACHMENT_RETENTION_MS,
  avatarCacheControl: env.AVATAR_CACHE_CONTROL,
});

export const storageClient = createS3Client(clientConfig);
export const objectStorage = new S3ObjectStorage(storageClient);
