import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaReadRepository } from "./read.repository.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

describe("Prisma read repository", () => {
  it("uses one parameterized conditional upsert with RETURNING", async () => {
    const queryRaw = vi.fn(async (_query: unknown) => [
      {
        targetExists: true,
        previousMessageId: null,
        previousReadAt: null,
        currentMessageId: MESSAGE_ID,
        currentReadAt: NOW,
      },
    ]);
    const client = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const repository = new PrismaReadRepository(client);

    const result = await repository.updateWatermark({
      conversationId: CONVERSATION_ID,
      userId: ALICE_ID,
      throughMessageId: MESSAGE_ID,
    });

    expect(result.currentMessageId).toBe(MESSAGE_ID);
    expect(queryRaw).toHaveBeenCalledOnce();
    const query = queryRaw.mock.calls[0]?.[0] as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toContain("ON CONFLICT");
    expect(query.sql).toContain("DO UPDATE");
    expect(query.sql).toContain("RETURNING");
    expect(query.sql).toContain("target.created_at, target.id");
    expect(query.values).toContain(MESSAGE_ID);
    expect(query.values).toContain(CONVERSATION_ID);
    expect(query.values).toContain(ALICE_ID);
  });
});
