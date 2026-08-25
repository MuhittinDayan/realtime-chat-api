import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { argon2id, hash } from "argon2";

import { PrismaClient } from "../src/generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required to run the seed script.");
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TEST_PASSWORD = "ChatMvp123!";

async function main(): Promise<void> {
  const [alicePasswordHash, bobPasswordHash] = await Promise.all([
    hash(TEST_PASSWORD, { type: argon2id }),
    hash(TEST_PASSWORD, { type: argon2id }),
  ]);

  await prisma.$transaction([
    prisma.user.upsert({
      where: { email: "alice@example.com" },
      update: {
        username: "alice",
        displayName: "Alice",
        passwordHash: alicePasswordHash,
      },
      create: {
        email: "alice@example.com",
        username: "alice",
        displayName: "Alice",
        passwordHash: alicePasswordHash,
      },
    }),
    prisma.user.upsert({
      where: { email: "bob@example.com" },
      update: {
        username: "bob",
        displayName: "Bob",
        passwordHash: bobPasswordHash,
      },
      create: {
        email: "bob@example.com",
        username: "bob",
        displayName: "Bob",
        passwordHash: bobPasswordHash,
      },
    }),
  ]);

  console.info("Seeded alice@example.com and bob@example.com.");
  console.info(`Test password: ${TEST_PASSWORD}`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
