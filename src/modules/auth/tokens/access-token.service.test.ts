import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import type { Clock } from "../../../shared/time/clock.js";
import { InvalidTokenError } from "../auth.errors.js";
import { AccessTokenService } from "./access-token.service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const fixedClock: Clock = {
  now: () => NOW,
};

function createService(clock: Clock = fixedClock): AccessTokenService {
  return new AccessTokenService(
    {
      secret: "test-secret-with-at-least-thirty-two-bytes",
      issuer: "chat-api-test",
      audience: "chat-web-test",
      ttlMinutes: 15,
    },
    clock,
  );
}

describe("access token service", () => {
  it("creates and verifies a typed access token", async () => {
    const service = createService();
    const issued = await service.createAccessToken({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const payload = await service.verifyAccessToken(issued.token);
    const issuedAt = Math.floor(NOW.getTime() / 1_000);

    expect(payload.sub).toBe(USER_ID);
    expect(payload.sid).toBe(SESSION_ID);
    expect(payload.iss).toBe("chat-api-test");
    expect(payload.aud).toBe("chat-web-test");
    expect(payload.iat).toBe(issuedAt);
    expect(payload.exp).toBe(issuedAt + 15 * 60);
    expect(payload.jti).toHaveLength(36);
    expect(issued.expiresAt).toEqual(new Date((issuedAt + 15 * 60) * 1_000));
  });

  it("rejects a corrupted access token", async () => {
    const service = createService();
    const issued = await service.createAccessToken({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

    await expect(
      service.verifyAccessToken(`${issued.token}corrupted`),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects an expired access token", async () => {
    const issuer = createService();
    const issued = await issuer.createAccessToken({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const verifier = createService({
      now: () => new Date(NOW.getTime() + 16 * 60 * 1_000),
    });

    await expect(
      verifier.verifyAccessToken(issued.token),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("does not issue a token for non-UUID identifiers", async () => {
    const service = createService();

    await expect(
      service.createAccessToken({
        userId: "not-a-uuid",
        sessionId: SESSION_ID,
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});
