import { createHash, randomBytes } from "node:crypto";

const REFRESH_TOKEN_BYTES = 32;
const REFRESH_TOKEN_PREFIX = "rt_";

export interface RefreshTokenCodec {
  generateRefreshToken(): string;
  hashRefreshToken(token: string): string;
}

export function generateRefreshToken(): string {
  return `${REFRESH_TOKEN_PREFIX}${randomBytes(REFRESH_TOKEN_BYTES).toString("base64url")}`;
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export const refreshTokenCodec: RefreshTokenCodec = Object.freeze({
  generateRefreshToken,
  hashRefreshToken,
});
