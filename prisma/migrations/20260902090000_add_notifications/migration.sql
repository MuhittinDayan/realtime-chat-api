-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('MESSAGE_CREATED');

-- AlterTable
ALTER TABLE "conversation_members"
    ADD COLUMN "muted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMPTZ(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_user_id_message_id_type_key"
    ON "notifications"("recipient_user_id", "message_id", "type");

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_created_at_idx"
    ON "notifications"("recipient_user_id", "read_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_conversation_id_read_at_idx"
    ON "notifications"("recipient_user_id", "conversation_id", "read_at");

-- AddForeignKey
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "messages"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
