import {
  Prisma,
  type PrismaClient,
} from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";

export interface UpdateReadWatermarkRepositoryInput {
  conversationId: string;
  userId: string;
  throughMessageId: string;
}

export interface ReadWatermarkMutationResult {
  targetExists: boolean;
  previousMessageId: string | null;
  previousReadAt: Date | null;
  currentMessageId: string | null;
  currentReadAt: Date | null;
}

export interface ReadRepository {
  updateWatermark(
    input: UpdateReadWatermarkRepositoryInput,
  ): Promise<ReadWatermarkMutationResult>;
}

interface RawReadWatermarkMutationRow {
  targetExists: boolean;
  previousMessageId: string | null;
  previousReadAt: Date | null;
  currentMessageId: string | null;
  currentReadAt: Date | null;
}

export class PrismaReadRepository implements ReadRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async updateWatermark(
    input: UpdateReadWatermarkRepositoryInput,
  ): Promise<ReadWatermarkMutationResult> {
    const rows = await this.client.$queryRaw<
      RawReadWatermarkMutationRow[]
    >(Prisma.sql`
      WITH target_message AS MATERIALIZED (
        SELECT id, created_at
        FROM messages
        WHERE id = ${input.throughMessageId}::uuid
          AND conversation_id = ${input.conversationId}::uuid
      ),
      previous_watermark AS MATERIALIZED (
        SELECT
          mr.last_read_message_id,
          mr.read_at
        FROM message_reads AS mr
        WHERE mr.conversation_id = ${input.conversationId}::uuid
          AND mr.user_id = ${input.userId}::uuid
      ),
      upserted AS (
        INSERT INTO message_reads (
          conversation_id,
          user_id,
          last_read_message_id,
          read_at
        )
        SELECT
          ${input.conversationId}::uuid,
          ${input.userId}::uuid,
          target_message.id,
          clock_timestamp()
        FROM target_message
        ON CONFLICT (conversation_id, user_id) DO UPDATE
        SET
          last_read_message_id = EXCLUDED.last_read_message_id,
          read_at = EXCLUDED.read_at
        WHERE EXISTS (
          SELECT 1
          FROM target_message AS target
          JOIN messages AS current_message
            ON current_message.id = message_reads.last_read_message_id
          WHERE (target.created_at, target.id)
              > (current_message.created_at, current_message.id)
        )
        RETURNING last_read_message_id, read_at
      )
      SELECT
        EXISTS (SELECT 1 FROM target_message) AS "targetExists",
        (SELECT last_read_message_id FROM previous_watermark)
          AS "previousMessageId",
        (SELECT read_at FROM previous_watermark) AS "previousReadAt",
        COALESCE(
          (SELECT last_read_message_id FROM upserted),
          (SELECT last_read_message_id FROM previous_watermark)
        ) AS "currentMessageId",
        COALESCE(
          (SELECT read_at FROM upserted),
          (SELECT read_at FROM previous_watermark)
        ) AS "currentReadAt"
    `);
    const row = rows[0];

    if (row === undefined) {
      throw new Error("Read watermark mutation returned no result");
    }

    return row;
  }
}
