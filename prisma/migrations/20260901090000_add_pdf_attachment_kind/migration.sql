-- CreateEnum
CREATE TYPE "attachment_kind" AS ENUM ('IMAGE', 'PDF');

-- AlterTable
ALTER TABLE "message_attachments" ADD COLUMN "kind" "attachment_kind";

-- DataMigration
UPDATE "message_attachments" SET "kind" = 'IMAGE';

-- EnforceConstraint
ALTER TABLE "message_attachments" ALTER COLUMN "kind" SET NOT NULL;
