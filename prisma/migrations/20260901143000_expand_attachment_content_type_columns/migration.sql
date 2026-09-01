-- AlterTable
ALTER TABLE "media_assets"
  ALTER COLUMN "declared_content_type" TYPE VARCHAR(128),
  ALTER COLUMN "detected_content_type" TYPE VARCHAR(128);
