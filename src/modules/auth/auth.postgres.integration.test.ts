import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../../infrastructure/database/prisma.js";
import type { Clock } from "../../shared/time/clock.js";
import { UsernameAlreadyInUseError, InvalidTokenError } from "./auth.errors.js";
import { PrismaAuthRepository } from "./auth.repository.js";
import { AuthService, type PasswordService } from "./auth.service.js";
import { PrismaAuthSessionRepository } from "./sessions/auth-session.repository.js";
import { AuthSessionService } from "./sessions/auth-session.service.js";
import { AccessTokenService } from "./tokens/access-token.service.js";
import { PrismaUsersRepository } from "../users/users.repository.js";
import { UsersService } from "../users/users.service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_IDS = [USER_ID, OTHER_USER_ID];

const fixedClock: Clock = { now: () => NOW };
const passwordService: PasswordService = {
  hashPassword: async (password) => `hashed:${password}`,
  verifyPassword: async (passwordHash, password) =>
    passwordHash === `hashed:${password}`,
};

function createRuntime(): {
  authService: AuthService;
  sessionService: AuthSessionService;
} {
  const accessTokenService = new AccessTokenService(
    {
      secret: "phase-13a-test-secret-with-at-least-32-bytes",
      issuer: "phase-13a-test",
      audience: "phase-13a-test",
      ttlMinutes: 15,
    },
    fixedClock,
  );
  const sessionService = new AuthSessionService({
    sessionRepository: new PrismaAuthSessionRepository(prisma),
    accessTokenService,
    refreshTokenTtlDays: 30,
    clock: fixedClock,
  });
  const authService = new AuthService({
    authRepository: new PrismaAuthRepository(prisma),
    authSessionService: sessionService,
    accessTokenVerifier: accessTokenService,
    passwordService,
    dummyPasswordHash: "hashed:dummy-password",
  });

  return { authService, sessionService };
}

async function cleanFixtureUsers(): Promise<void> {
  await prisma.authSession.deleteMany({ where: { userId: { in: USER_IDS } } });
  await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
}

beforeEach(async () => {
  await cleanFixtureUsers();
  await prisma.user.createMany({
    data: [
      {
        id: USER_ID,
        email: "phase13a-alice@example.com",
        username: "phase13a-alice",
        displayName: "Phase 13a Alice",
        passwordHash: "hashed:current-password",
      },
      {
        id: OTHER_USER_ID,
        email: "phase13a-bob@example.com",
        username: "phase13a-bob",
        displayName: "Phase 13a Bob",
        passwordHash: "hashed:current-password",
      },
    ],
  });
});

afterEach(cleanFixtureUsers);

describe("phase 13a PostgreSQL behavior", () => {
  it("changes the password, invalidates other sessions, and keeps the current session active", async () => {
    const { authService, sessionService } = createRuntime();
    const current = await sessionService.createSession({
      userId: USER_ID,
      userAgent: "Current Firefox",
    });
    const other = await sessionService.createSession({
      userId: USER_ID,
      userAgent: "Other Chrome",
    });

    await authService.changePassword(USER_ID, current.sessionId, {
      currentPassword: "current-password",
      newPassword: "different-password",
    });

    const rows = await prisma.authSession.findMany({
      where: { userId: USER_ID },
      orderBy: { id: "asc" },
    });
    expect(rows.find((row) => row.id === current.sessionId)?.revokedAt).toBeNull();
    expect(rows.find((row) => row.id === other.sessionId)?.revokedAt).toEqual(NOW);
    await expect(
      authService.authenticateAccessToken(current.accessToken),
    ).resolves.toEqual(expect.objectContaining({ sessionId: current.sessionId }));
    await expect(
      authService.authenticateAccessToken(other.accessToken),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("maps a real username unique constraint violation to conflict", async () => {
    const service = new UsersService(new PrismaUsersRepository(prisma));

    await expect(
      service.updateCurrentUser(USER_ID, { username: "phase13a-bob" }),
    ).rejects.toBeInstanceOf(UsernameAlreadyInUseError);
  });

  it("revokes a selected owned session without affecting another session", async () => {
    const { authService, sessionService } = createRuntime();
    const kept = await sessionService.createSession({
      userId: USER_ID,
      userAgent: "Kept device",
    });
    const selected = await sessionService.createSession({
      userId: USER_ID,
      userAgent: "Selected device",
    });

    await expect(
      authService.revokeOwnedSession(USER_ID, selected.sessionId),
    ).resolves.toBe(true);

    await expect(
      authService.authenticateAccessToken(kept.accessToken),
    ).resolves.toEqual(expect.objectContaining({ sessionId: kept.sessionId }));
    await expect(
      authService.authenticateAccessToken(selected.accessToken),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
