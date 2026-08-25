import { PrismaPg } from "@prisma/adapter-pg";

import { env } from "../../config/env.js";
import { PrismaClient } from "../../generated/prisma/client.js";

type PrismaGlobal = typeof globalThis & {
  __chatApiPrisma?: PrismaClient;
};

const prismaGlobal = globalThis as PrismaGlobal;

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
  });

  return new PrismaClient({ adapter });
}

export const prisma = prismaGlobal.__chatApiPrisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  prismaGlobal.__chatApiPrisma = prisma;
}
