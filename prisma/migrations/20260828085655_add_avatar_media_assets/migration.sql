-- CreateEnum
CREATE TYPE "media_purpose" AS ENUM ('AVATAR');

-- CreateEnum
CREATE TYPE "media_status" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "avatar_asset_id" UUID;

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "purpose" "media_purpose" NOT NULL DEFAULT 'AVATAR',
    "status" "media_status" NOT NULL DEFAULT 'PENDING',
    "declared_content_type" VARCHAR(64) NOT NULL,
    "declared_size" INTEGER NOT NULL,
    "detected_content_type" VARCHAR(64),
    "actual_size" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "incoming_object_key" TEXT,
    "ready_object_key" TEXT,
    "public_url" TEXT,
    "upload_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "ready_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_incoming_object_key_key" ON "media_assets"("incoming_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_ready_object_key_key" ON "media_assets"("ready_object_key");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_public_url_key" ON "media_assets"("public_url");

-- CreateIndex
CREATE INDEX "media_assets_owner_id_purpose_status_created_at_idx" ON "media_assets"("owner_id", "purpose", "status", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_status_upload_expires_at_idx" ON "media_assets"("status", "upload_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_avatar_asset_id_key" ON "users"("avatar_asset_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_asset_id_fkey" FOREIGN KEY ("avatar_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
