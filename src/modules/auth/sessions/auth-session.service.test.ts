import { describe, expect, it } from "vitest";

import type { Clock } from "../../../shared/time/clock.js";
import {
  InvalidRefreshTokenError,
  InvalidTokenError,
  SessionExpiredError,
  SessionRevokedError,
} from "../auth.errors.js";
import type { AccessTokenIssuer } from "../tokens/access-token.service.js";
import type { RefreshTokenCodec } from "../tokens/refresh-token.service.js";
import { AuthSessionService } from "./auth-session.service.js";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionData,
  FindActiveAuthSessionData,
  ListActiveAuthSessionsData,
  RevokeAuthSessionData,
  RevokeOtherAuthSessionsData,
  RotateRefreshTokenData,
} from "./auth-session.types.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

class InMemoryAuthSessionRepository implements AuthSessionRepository {
  readonly sessions = new Map<string, AuthSessionRecord>();
  readonly sessionIdsByRefreshTokenHash = new Map<string, string>();
  lastCreatedData: CreateAuthSessionData | null = null;

  constructor(initialSessions: readonly AuthSessionRecord[] = []) {
    for (const session of initialSessions) {
      this.sessions.set(session.id, session);
    }
  }

  seedRefreshToken(sessionId: string, refreshTokenHash: string): void {
    this.sessionIdsByRefreshTokenHash.set(refreshTokenHash, sessionId);
  }

  async createSession(data: CreateAuthSessionData): Promise<AuthSessionRecord> {
    this.lastCreatedData = data;

    const session: AuthSessionRecord = {
      id: data.id,
      userId: data.userId,
      userAgent: data.userAgent,
      expiresAt: data.expiresAt,
      lastUsedAt: data.lastUsedAt,
      revokedAt: null,
      createdAt: data.lastUsedAt,
    };

    this.sessions.set(session.id, session);
    this.sessionIdsByRefreshTokenHash.set(data.refreshTokenHash, session.id);

    return session;
  }

  async findSessionById(
    sessionId: string,
  ): Promise<AuthSessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async findActiveSessionById(
    data: FindActiveAuthSessionData,
  ): Promise<AuthSessionRecord | null> {
    const session = this.sessions.get(data.sessionId);

    if (
      session === undefined ||
      session.userId !== data.userId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= data.now.getTime()
    ) {
      return null;
    }

    return session;
  }

  async findSessionByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<AuthSessionRecord | null> {
    const sessionId = this.sessionIdsByRefreshTokenHash.get(refreshTokenHash);

    return sessionId === undefined ? null : this.findSessionById(sessionId);
  }

  async rotateRefreshToken(data: RotateRefreshTokenData): Promise<boolean> {
    const sessionId = this.sessionIdsByRefreshTokenHash.get(
      data.currentRefreshTokenHash,
    );
    const session =
      sessionId === undefined ? undefined : this.sessions.get(sessionId);

    if (
      session === undefined ||
      session.id !== data.sessionId ||
      session.userId !== data.userId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= data.rotatedAt.getTime() ||
      session.lastUsedAt.getTime() > data.rotatedAt.getTime()
    ) {
      return false;
    }

    this.sessionIdsByRefreshTokenHash.delete(data.currentRefreshTokenHash);
    this.sessionIdsByRefreshTokenHash.set(
      data.nextRefreshTokenHash,
      session.id,
    );
    this.sessions.set(session.id, {
      ...session,
      lastUsedAt: data.rotatedAt,
    });

    return true;
  }

  async listActiveSessions(
    data: ListActiveAuthSessionsData,
  ): Promise<readonly AuthSessionRecord[]> {
    return [...this.sessions.values()].filter(
      (session) =>
        session.userId === data.userId &&
        session.revokedAt === null &&
        session.expiresAt.getTime() > data.now.getTime(),
    );
  }

  async revokeSession(data: RevokeAuthSessionData): Promise<boolean> {
    const session = this.sessions.get(data.sessionId);

    if (
      session === undefined ||
      session.userId !== data.userId ||
      session.revokedAt !== null
    ) {
      return false;
    }

    this.sessions.set(session.id, {
      ...session,
      revokedAt: data.revokedAt,
    });

    return true;
  }

  async revokeOtherSessions(
    data: RevokeOtherAuthSessionsData,
  ): Promise<readonly string[]> {
    const revokedIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (
        session.userId === data.userId &&
        session.id !== data.currentSessionId &&
        session.revokedAt === null
      ) {
        this.sessions.set(session.id, {
          ...session,
          revokedAt: data.revokedAt,
        });
        revokedIds.push(session.id);
      }
    }

    return revokedIds;
  }

  async updateLastUsedAt(
    sessionId: string,
    lastUsedAt: Date,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);

    if (
      session === undefined ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= lastUsedAt.getTime() ||
      session.lastUsedAt.getTime() > lastUsedAt.getTime()
    ) {
      return false;
    }

    this.sessions.set(sessionId, { ...session, lastUsedAt });

    return true;
  }
}

const fixedClock: Clock = {
  now: () => NOW,
};

const accessTokenIssuer: AccessTokenIssuer = {
  createAccessToken: async ({ sessionId }) => ({
    token: `access-token-for-${sessionId}`,
    expiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000),
  }),
};

const deterministicRefreshTokenCodec: RefreshTokenCodec = {
  generateRefreshToken: () => "rt_plaintext-test-token",
  hashRefreshToken: (token) => `sha256:${token}`,
};

function createService(
  sessionRepository: AuthSessionRepository,
  refreshTokenCodec: RefreshTokenCodec = deterministicRefreshTokenCodec,
): AuthSessionService {
  return new AuthSessionService({
    sessionRepository,
    accessTokenService: accessTokenIssuer,
    refreshTokenTtlDays: 30,
    clock: fixedClock,
    refreshTokenCodec,
  });
}

function createSequentialRefreshTokenCodec(
  tokens: readonly string[],
): RefreshTokenCodec {
  let index = 0;

  return {
    generateRefreshToken: () => {
      const token = tokens[index];
      index += 1;

      if (token === undefined) {
        throw new Error("No refresh token configured for the test");
      }

      return token;
    },
    hashRefreshToken: (token) => `sha256:${token}`,
  };
}

function createSessionRecord(
  overrides: Partial<AuthSessionRecord> = {},
): AuthSessionRecord {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    userAgent: null,
    expiresAt: new Date(NOW.getTime() + 60_000),
    lastUsedAt: NOW,
    revokedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("auth session service", () => {
  it("stores only the refresh token hash when creating a session", async () => {
    const repository = new InMemoryAuthSessionRepository();
    const service = createService(repository);
    const created = await service.createSession({
      userId: USER_ID,
      userAgent: "Firefox test agent",
    });
    const persisted = repository.lastCreatedData;

    expect(persisted).not.toBeNull();

    if (persisted === null) {
      throw new Error("Expected the session to be persisted");
    }

    expect(persisted.refreshTokenHash).toBe(
      "sha256:rt_plaintext-test-token",
    );
    expect(persisted.refreshTokenHash).not.toBe(created.refreshToken);
    expect(persisted.userAgent).toBe("Firefox test agent");
    expect(created.refreshToken).toBe("rt_plaintext-test-token");
    expect(created.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(created.accessToken).toBe(
      `access-token-for-${created.sessionId}`,
    );
    expect(created.refreshTokenExpiresAt).toEqual(
      new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1_000),
    );

    const activeSession = await service.findActiveSessionForUser({
      sessionId: created.sessionId,
      userId: created.userId,
    });

    expect(activeSession.id).toBe(created.sessionId);
    expect(activeSession).not.toHaveProperty("refreshTokenHash");
  });

  it("rejects a revoked session", () => {
    const session = createSessionRecord({ revokedAt: NOW });
    const service = createService(
      new InMemoryAuthSessionRepository([session]),
    );

    expect(() => service.assertSessionUsable(session)).toThrow(
      SessionRevokedError,
    );
  });

  it("rejects a session that expires at the current instant", () => {
    const session = createSessionRecord({ expiresAt: NOW });
    const service = createService(
      new InMemoryAuthSessionRepository([session]),
    );

    expect(() => service.assertSessionUsable(session)).toThrow(
      SessionExpiredError,
    );
  });

  it("rejects a revoked session during bearer session validation", async () => {
    const session = createSessionRecord({ revokedAt: NOW });
    const service = createService(
      new InMemoryAuthSessionRepository([session]),
    );

    await expect(
      service.findActiveSessionForUser({
        sessionId: session.id,
        userId: session.userId,
      }),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rotates a refresh token and rejects the previous token", async () => {
    const session = createSessionRecord();
    const repository = new InMemoryAuthSessionRepository([session]);
    repository.seedRefreshToken(session.id, "sha256:rt_old-token");
    const service = createService(
      repository,
      createSequentialRefreshTokenCodec(["rt_new-token"]),
    );

    const rotated = await service.rotateRefreshToken("rt_old-token");

    expect(rotated.refreshToken).toBe("rt_new-token");
    expect(rotated.accessToken).toBe(`access-token-for-${session.id}`);
    await expect(
      service.rotateRefreshToken("rt_old-token"),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
  });

  it("rejects refresh for a revoked session", async () => {
    const session = createSessionRecord({ revokedAt: NOW });
    const repository = new InMemoryAuthSessionRepository([session]);
    repository.seedRefreshToken(session.id, "sha256:rt_revoked-token");
    const service = createService(
      repository,
      createSequentialRefreshTokenCodec(["rt_unused-token"]),
    );

    await expect(
      service.rotateRefreshToken("rt_revoked-token"),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
  });

  it("rejects refresh for an expired session", async () => {
    const session = createSessionRecord({ expiresAt: NOW });
    const repository = new InMemoryAuthSessionRepository([session]);
    repository.seedRefreshToken(session.id, "sha256:rt_expired-token");
    const service = createService(
      repository,
      createSequentialRefreshTokenCodec(["rt_unused-token"]),
    );

    await expect(
      service.rotateRefreshToken("rt_expired-token"),
    ).rejects.toBeInstanceOf(InvalidRefreshTokenError);
  });

  it("allows only one concurrent rotation for the same refresh token", async () => {
    const session = createSessionRecord();
    const repository = new InMemoryAuthSessionRepository([session]);
    repository.seedRefreshToken(session.id, "sha256:rt_shared-token");
    const service = createService(
      repository,
      createSequentialRefreshTokenCodec([
        "rt_concurrent-token-a",
        "rt_concurrent-token-b",
      ]),
    );

    const results = await Promise.allSettled([
      service.rotateRefreshToken("rt_shared-token"),
      service.rotateRefreshToken("rt_shared-token"),
    ]);
    const fulfilled = results.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = results.filter((result) => result.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejectionReason: unknown = rejected[0]?.reason;

    expect(rejectionReason).toBeInstanceOf(InvalidRefreshTokenError);
  });

  it("lists only active sessions and revokes all except the current one", async () => {
    const current = createSessionRecord();
    const other = createSessionRecord({
      id: "33333333-3333-4333-8333-333333333333",
      userAgent: "Chrome",
    });
    const expired = createSessionRecord({
      id: "44444444-4444-4444-8444-444444444444",
      expiresAt: NOW,
    });
    const repository = new InMemoryAuthSessionRepository([
      current,
      other,
      expired,
    ]);
    const service = createService(repository);

    await expect(service.listActiveSessions(USER_ID)).resolves.toEqual([
      current,
      other,
    ]);
    await expect(
      service.revokeOtherSessions(USER_ID, current.id),
    ).resolves.toEqual([other.id, expired.id]);
    expect(repository.sessions.get(current.id)?.revokedAt).toBeNull();
    expect(repository.sessions.get(other.id)?.revokedAt).toEqual(NOW);
  });
});
