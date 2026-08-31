-- AlterEnum
ALTER TYPE "media_purpose" ADD VALUE 'MESSAGE_ATTACHMENT';

-- AlterEnum
ALTER TYPE "message_kind" ADD VALUE 'MEDIA';

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "body" DROP NOT NULL;

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID,
    "original_file_name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "thumbnail_object_key" TEXT,
    "purge_after" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_asset_id_key" ON "message_attachments"("asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_thumbnail_object_key_key" ON "message_attachments"("thumbnail_object_key");

-- CreateIndex
CREATE INDEX "message_attachments_conversation_id_message_id_idx" ON "message_attachments"("conversation_id", "message_id");

-- CreateIndex
CREATE INDEX "message_attachments_purge_after_idx" ON "message_attachments"("purge_after");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_message_id_position_key" ON "message_attachments"("message_id", "position");

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
