import { beforeAll, describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.service.js";

describe("password service", () => {
  const password = "correct horse battery staple";
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await hashPassword(password);
  });

  it("hashes and verifies a password with Argon2id", async () => {
    expect(passwordHash).toMatch(/^\$argon2id\$/u);
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    await expect(
      verifyPassword(passwordHash, "incorrect password"),
    ).resolves.toBe(false);
  });
});
