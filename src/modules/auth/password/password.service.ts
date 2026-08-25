import {
  argon2id,
  hash as createArgon2Hash,
  verify as verifyArgon2Hash,
  type HashOptions,
} from "argon2";

const PASSWORD_HASH_OPTIONS: HashOptions = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=1,t=3$45mItEEZ7exrh7MdknQsYQ$UrBHFN5SZWY2Khd0bGqLqOlmNOGsIyEO0Ni9qWUy0EM";

export async function hashPassword(password: string): Promise<string> {
  return createArgon2Hash(password, PASSWORD_HASH_OPTIONS);
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return verifyArgon2Hash(passwordHash, password);
}
