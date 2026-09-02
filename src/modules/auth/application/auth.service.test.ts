import { describe, expect, it } from "vitest";
import { RequestValidationError } from "../../../shared/errors/request-validation-error.js";

import {
  EmailAlreadyInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  UsernameAlreadyInUseError,
} from "../domain/auth.errors.js";
import type {
  AuthSessionRecord,
} from "../sessions/auth-session.types.js";
import type {
  AuthRepository,
  AuthUserRecord,
  CreateUserData,
  UserRecord,
} from "../persistence/auth.repository.js";
import { UserUniqueConstraintError } from "../persistence/auth.repository.js";
import {
  AuthService,
  type AuthSessionManager,
  type PasswordService,
  type SessionRevocationPublisher,
} from "./auth.service.js";
import type {
  CreatedAuthSession,
  RevokeAuthSessionInput,
  RotatedAuthSession,
} from "../sessions/auth-session.service.js";
import type { AccessTokenPayload } from "../tokens/access-token.service.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function toUserRecord(user: AuthUserRecord): UserRecord {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    createdAt: user.createdAt,
    deletedAt: user.deletedAt,
  };
}

function createUser(
  overrides: Partial<AuthUserRecord> = {},
): AuthUserRecord {
  return {
    id: USER_ID,
    email: "alice@example.com",
    username: "alice",
    displayName: "Alice",
    avatarUrl: null,
    status: "ACTIVE",
    createdAt: NOW,
    deletedAt: null,
    passwordHash: "hashed:correct-password",
    ...overrides,
  };
}

class InMemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, AuthUserRecord>();
  createError: unknown = null;

  constructor(initialUsers: readonly AuthUserRecord[] = []) {
    for (const user of initialUsers) {
      this.users.set(user.id, user);
    }
  }

  async findUserByEmail(email: string): Promise<AuthUserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return user;
      }
    }

    return null;
  }

  async findAuthUserById(userId: string): Promise<AuthUserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const user = this.users.get(userId);

    return user === undefined ? null : toUserRecord(user);
  }

  async findUserByUsername(
    username: string,
  ): Promise<{ id: string } | null> {
    for (const user of this.users.values()) {
      if (user.username === username) {
        return { id: user.id };
      }
    }

    return null;
  }

  async createUser(data: CreateUserData): Promise<UserRecord> {
    if (this.createError !== null) {
      throw this.createError;
    }

    const user = createUser({
      email: data.email,
      username: data.username,
      displayName: data.displayName,
      passwordHash: data.passwordHash,
      status: data.status,
    });
    this.users.set(user.id, user);

    return toUserRecord(user);
  }

  async updatePassword(userId: string, passwordHash: string): Promise<boolean> {
    const user = this.users.get(userId);

    if (user === undefined || user.status !== "ACTIVE" || user.deletedAt !== null) {
      return false;
    }

    this.users.set(userId, { ...user, passwordHash });
    return true;
  }
}

class FakePasswordService implements PasswordService {
  lastVerifiedHash: string | null = null;

  async hashPassword(password: string): Promise<string> {
    return `hashed:${password}`;
  }

  async verifyPassword(
    passwordHash: string,
    password: string,
  ): Promise<boolean> {
    this.lastVerifiedHash = passwordHash;

    return passwordHash === `hashed:${password}`;
  }
}

class FakeAuthSessionManager implements AuthSessionManager {
  revokedSession: RevokeAuthSessionInput | null = null;
  validatedSession: RevokeAuthSessionInput | null = null;
  sessions: readonly AuthSessionRecord[] = [];
  otherSessionIds: readonly string[] = [];
  revokeOtherInput: { userId: string; currentSessionId: string } | null = null;

  async createSession(input: {
    userId: string;
    userAgent: string | null;
  }): Promise<CreatedAuthSession> {
    return {
      sessionId: SESSION_ID,
      userId: input.userId,
      accessToken: "access-token",
      accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000),
      refreshToken: "refresh-token",
      refreshTokenExpiresAt: new Date(
        NOW.getTime() + 30 * 24 * 60 * 60 * 1_000,
      ),
    };
  }

  async findActiveSessionForUser(
    input: RevokeAuthSessionInput,
  ): Promise<void> {
    this.validatedSession = input;
  }

  async rotateRefreshToken(
    _refreshToken: string,
  ): Promise<RotatedAuthSession> {
    return {
      sessionId: SESSION_ID,
      userId: USER_ID,
      accessToken: "rotated-access-token",
      accessTokenExpiresAt: new Date(NOW.getTime() + 15 * 60 * 1_000),
      refreshToken: "rotated-refresh-token",
      refreshTokenExpiresAt: new Date(
        NOW.getTime() + 30 * 24 * 60 * 60 * 1_000,
      ),
    };
  }

  async listActiveSessions(): Promise<readonly AuthSessionRecord[]> {
    return this.sessions;
  }

  async revokeSession(input: RevokeAuthSessionInput): Promise<boolean> {
    this.revokedSession = input;
    return true;
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<readonly string[]> {
    this.revokeOtherInput = { userId, currentSessionId };
    return this.otherSessionIds;
  }
}

class FakeSessionRevocationPublisher implements SessionRevocationPublisher {
  readonly publishedSessionIds: string[][] = [];

  publishRevoked(sessionIds: readonly string[]): void {
    this.publishedSessionIds.push([...sessionIds]);
  }
}

class FakeAccessTokenVerifier {
  async verifyAccessToken(_token: string): Promise<AccessTokenPayload> {
    return {
      sub: USER_ID,
      sid: SESSION_ID,
      jti: "33333333-3333-4333-8333-333333333333",
      iss: "chat-api-test",
      aud: "chat-web-test",
      iat: 1_893_456_000,
      exp: 1_893_456_900,
    };
  }
}

function createHarness(initialUsers: readonly AuthUserRecord[] = []): {
  service: AuthService;
  repository: InMemoryAuthRepository;
  passwordService: FakePasswordService;
  sessionManager: FakeAuthSessionManager;
  sessionRevocationPublisher: FakeSessionRevocationPublisher;
} {
  const repository = new InMemoryAuthRepository(initialUsers);
  const passwordService = new FakePasswordService();
  const sessionManager = new FakeAuthSessionManager();
  const sessionRevocationPublisher = new FakeSessionRevocationPublisher();
  const service = new AuthService({
    authRepository: repository,
    authSessionService: sessionManager,
    accessTokenVerifier: new FakeAccessTokenVerifier(),
    passwordService,
    dummyPasswordHash: "dummy-password-hash",
    sessionRevocationPublisher,
  });

  return {
    service,
    repository,
    passwordService,
    sessionManager,
    sessionRevocationPublisher,
  };
}

describe("auth service registration", () => {
  it("registers an active user and creates a session", async () => {
    const { service } = createHarness();

    const result = await service.register({
      email: "  Alice@Example.COM ",
      username: "alice",
      displayName: "Alice",
      password: "correct-password",
    });

    expect(result.user.email).toBe("alice@example.com");
    expect(result.user.status).toBe("ACTIVE");
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(result.accessToken).toBe("access-token");
    expect(result.refreshToken).toBe("refresh-token");
  });

  it("rejects a duplicate email", async () => {
    const { service } = createHarness([createUser()]);

    await expect(
      service.register({
        email: "ALICE@example.com",
        username: "another-user",
        displayName: "Another User",
        password: "correct-password",
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError);
  });

  it("rejects a duplicate username", async () => {
    const { service } = createHarness([createUser()]);

    await expect(
      service.register({
        email: "another@example.com",
        username: "alice",
        displayName: "Another User",
        password: "correct-password",
      }),
    ).rejects.toBeInstanceOf(UsernameAlreadyInUseError);
  });

  it("maps a unique constraint race to a conflict", async () => {
    const { service, repository } = createHarness();
    repository.createError = new UserUniqueConstraintError(
      ["email"],
      new Error("simulated database conflict"),
    );

    await expect(
      service.register({
        email: "alice@example.com",
        username: "alice",
        displayName: "Alice",
        password: "correct-password",
      }),
    ).rejects.toBeInstanceOf(EmailAlreadyInUseError);
  });
});

describe("auth service login", () => {
  it("logs in an active user", async () => {
    const { service } = createHarness([createUser()]);

    const result = await service.login({
      email: "ALICE@EXAMPLE.COM",
      password: "correct-password",
    });

    expect(result.user.id).toBe(USER_ID);
    expect(result.accessToken).toBe("access-token");
  });

  it("returns generic invalid credentials for a wrong password", async () => {
    const { service } = createHarness([createUser()]);

    await expect(
      service.login({
        email: "alice@example.com",
        password: "wrong-password",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("returns generic invalid credentials for an unknown email", async () => {
    const { service, passwordService } = createHarness();

    await expect(
      service.login({
        email: "unknown@example.com",
        password: "wrong-password",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(passwordService.lastVerifiedHash).toBe("dummy-password-hash");
  });

  it("returns generic invalid credentials for a disabled user", async () => {
    const { service } = createHarness([
      createUser({ status: "DISABLED" }),
    ]);

    await expect(
      service.login({
        email: "alice@example.com",
        password: "correct-password",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });
});

describe("auth service current user and logout", () => {
  it("authenticates a JWT against its owned active session", async () => {
    const { service, sessionManager } = createHarness();

    const auth = await service.authenticateAccessToken("access-token");

    expect(auth).toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      jwtId: "33333333-3333-4333-8333-333333333333",
    });
    expect(sessionManager.validatedSession).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
  });

  it("returns an authenticated public user", async () => {
    const { service } = createHarness([createUser()]);

    const user = await service.getCurrentUser(USER_ID);

    expect(user.id).toBe(USER_ID);
    expect(user).not.toHaveProperty("passwordHash");
    expect(user).not.toHaveProperty("deletedAt");
  });

  it.each([
    createUser({ status: "DISABLED" }),
    createUser({ deletedAt: NOW }),
  ])("rejects a disabled or deleted current user", async (user) => {
    const { service } = createHarness([user]);

    await expect(service.getCurrentUser(USER_ID)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("revokes only the authenticated user's session", async () => {
    const { service, sessionManager } = createHarness();

    await service.logout({ sessionId: SESSION_ID, userId: USER_ID });

    expect(sessionManager.revokedSession).toEqual({
      sessionId: SESSION_ID,
      userId: USER_ID,
    });
  });
});

describe("auth service password and session management", () => {
  it("changes the password, revokes other sessions, and publishes their ids", async () => {
    const {
      service,
      repository,
      sessionManager,
      sessionRevocationPublisher,
    } = createHarness([createUser()]);
    sessionManager.otherSessionIds = ["other-session"];

    await service.changePassword(USER_ID, SESSION_ID, {
      currentPassword: "correct-password",
      newPassword: "a-different-password",
    });

    expect(repository.users.get(USER_ID)?.passwordHash).toBe(
      "hashed:a-different-password",
    );
    expect(sessionManager.revokeOtherInput).toEqual({
      userId: USER_ID,
      currentSessionId: SESSION_ID,
    });
    expect(sessionRevocationPublisher.publishedSessionIds).toEqual([
      ["other-session"],
    ]);
  });

  it("rejects an incorrect current password", async () => {
    const { service } = createHarness([createUser()]);

    await expect(
      service.changePassword(USER_ID, SESSION_ID, {
        currentPassword: "wrong-password",
        newPassword: "a-different-password",
      }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("requires the new password to differ from the current password", async () => {
    const { service } = createHarness([createUser()]);

    await expect(
      service.changePassword(USER_ID, SESSION_ID, {
        currentPassword: "correct-password",
        newPassword: "correct-password",
      }),
    ).rejects.toBeInstanceOf(RequestValidationError);
  });

  it("marks the current session and exposes only safe session fields", async () => {
    const { service, sessionManager } = createHarness();
    sessionManager.sessions = [
      {
        id: SESSION_ID,
        userId: USER_ID,
        userAgent: "Firefox",
        createdAt: NOW,
        lastUsedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000),
        revokedAt: null,
      },
    ];

    const result = await service.listSessions(USER_ID, SESSION_ID);

    expect(result.items).toEqual([
      expect.objectContaining({ id: SESSION_ID, isCurrent: true }),
    ]);
    expect(result.items[0]).not.toHaveProperty("userId");
    expect(result.items[0]).not.toHaveProperty("revokedAt");
  });

  it("revokes a selected owned session and all other sessions", async () => {
    const {
      service,
      sessionManager,
      sessionRevocationPublisher,
    } = createHarness();
    sessionManager.otherSessionIds = ["other-a", "other-b"];

    await expect(
      service.revokeOwnedSession(USER_ID, "selected-session"),
    ).resolves.toBe(true);
    await service.revokeOtherSessions(USER_ID, SESSION_ID);

    expect(sessionRevocationPublisher.publishedSessionIds).toEqual([
      ["selected-session"],
      ["other-a", "other-b"],
    ]);
  });
});
