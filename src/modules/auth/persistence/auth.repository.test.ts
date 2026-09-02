import { describe, expect, it } from "vitest";

import {
  Prisma,
  type PrismaClient,
} from "../../../generated/prisma/client.js";
import {
  PrismaAuthRepository,
  UserUniqueConstraintError,
} from "./auth.repository.js";

function createUniqueConstraintError(
  fields: readonly string[],
): InstanceType<typeof Prisma.PrismaClientKnownRequestError> {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed",
    {
      code: "P2002",
      clientVersion: "7.9.1",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields },
          },
        },
      },
    },
  );
}

describe("Prisma auth repository errors", () => {
  it.each(["email", "username"] as const)(
    "maps an adapter-pg %s unique constraint violation",
    async (field) => {
      const client = {
        user: {
          create: () => Promise.reject(createUniqueConstraintError([field])),
        },
      } as unknown as PrismaClient;
      const repository = new PrismaAuthRepository(client);

      try {
        await repository.createUser({
          email: "alice@example.com",
          username: "alice",
          displayName: "Alice",
          passwordHash: "not-plaintext",
          status: "ACTIVE",
        });
        throw new Error("Expected createUser to reject");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(UserUniqueConstraintError);

        if (!(error instanceof UserUniqueConstraintError)) {
          throw error;
        }

        expect(error.fields).toEqual([field]);
      }
    },
  );
});
