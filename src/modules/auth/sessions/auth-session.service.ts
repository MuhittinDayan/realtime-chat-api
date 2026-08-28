import { randomUUID } from "node:crypto";

import type { Clock } from "../../../shared/time/clock.js";
import {
  addDays,
  isExpired,
  systemClock,
} from "../../../shared/time/clock.js";
import {
  InvalidTokenError,
  InvalidRefreshTokenError,
  SessionExpiredError,
  SessionRevokedError,
} from "../auth.errors.js";
import type { AccessTokenIssuer } from "../tokens/access-token.service.js";
import {
  refreshTokenCodec,
  type RefreshTokenCodec,
} from "../tokens/refresh-token.service.js";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
} from "./auth-session.types.js";

export interface AuthSessionServiceDependencies {
  sessionRepository: AuthSessionRepository;
  accessTokenService: AccessTokenIssuer;
  refreshTokenTtlDays: number;
  clock?: Clock;
  refreshTokenCodec?: RefreshTokenCodec;
}

export interface CreateAuthSessionInput {
  userId: string;
  userAgent?: string | null;
}

export interface CreatedAuthSession {
  sessionId: string;
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface RotatedAuthSession {
  sessionId: string;
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface RevokeAuthSessionInput {
  sessionId: string;
  userId: string;
}

export interface FindActiveAuthSessionInput {
  sessionId: string;
  userId: string;
}

export class AuthSessionService {
  private readonly sessionRepository: AuthSessionRepository;
  private readonly accessTokenService: AccessTokenIssuer;
  private readonly refreshTokenTtlDays: number;
  private readonly clock: Clock;
  private readonly refreshTokenCodec: RefreshTokenCodec;

  constructor(dependencies: AuthSessionServiceDependencies) {
    if (
      !Number.isSafeInteger(dependencies.refreshTokenTtlDays) ||
      dependencies.refreshTokenTtlDays <= 0 ||
      dependencies.refreshTokenTtlDays > 365
    ) {
      throw new RangeError(
        "Refresh token TTL must be an integer between 1 and 365 days",
      );
    }

    this.sessionRepository = dependencies.sessionRepository;
    this.accessTokenService = dependencies.accessTokenService;
    this.refreshTokenTtlDays = dependencies.refreshTokenTtlDays;
    this.clock = dependencies.clock ?? systemClock;
    this.refreshTokenCodec =
      dependencies.refreshTokenCodec ?? refreshTokenCodec;
  }

  async createSession(
    input: CreateAuthSessionInput,
  ): Promise<CreatedAuthSession> {
    const now = this.clock.now();
    const refreshToken = this.refreshTokenCodec.generateRefreshToken();
    const refreshTokenHash =
      this.refreshTokenCodec.hashRefreshToken(refreshToken);
    const refreshTokenExpiresAt = addDays(now, this.refreshTokenTtlDays);
    const sessionId = randomUUID();
    const accessToken = await this.accessTokenService.createAccessToken({
      userId: input.userId,
      sessionId,
    });
    const session = await this.sessionRepository.createSession({
      id: sessionId,
      userId: input.userId,
      refreshTokenHash,
      userAgent: input.userAgent ?? null,
      expiresAt: refreshTokenExpiresAt,
      lastUsedAt: now,
    });

    return {
      sessionId: session.id,
      userId: session.userId,
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      refreshToken,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  async findActiveSessionForUser(
    input: FindActiveAuthSessionInput,
  ): Promise<AuthSessionRecord> {
    const session = await this.sessionRepository.findActiveSessionById({
      sessionId: input.sessionId,
      userId: input.userId,
      now: this.clock.now(),
    });

    if (session === null) {
      throw new InvalidTokenError();
    }

    return session;
  }

  async rotateRefreshToken(refreshToken: string): Promise<RotatedAuthSession> {
    const now = this.clock.now();
    const currentRefreshTokenHash =
      this.refreshTokenCodec.hashRefreshToken(refreshToken);
    const session =
      await this.sessionRepository.findSessionByRefreshTokenHash(
        currentRefreshTokenHash,
      );

    if (session === null) {
      throw new InvalidRefreshTokenError();
    }

    if (session.revokedAt !== null || isExpired(session.expiresAt, now)) {
      throw new InvalidRefreshTokenError();
    }

    const nextRefreshToken = this.refreshTokenCodec.generateRefreshToken();
    const nextRefreshTokenHash =
      this.refreshTokenCodec.hashRefreshToken(nextRefreshToken);

    if (nextRefreshTokenHash === currentRefreshTokenHash) {
      throw new InvalidRefreshTokenError();
    }

    const accessToken = await this.accessTokenService.createAccessToken({
      userId: session.userId,
      sessionId: session.id,
    });
    const rotated = await this.sessionRepository.rotateRefreshToken({
      sessionId: session.id,
      userId: session.userId,
      currentRefreshTokenHash,
      nextRefreshTokenHash,
      rotatedAt: now,
    });

    if (!rotated) {
      throw new InvalidRefreshTokenError();
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      accessToken: accessToken.token,
      accessTokenExpiresAt: accessToken.expiresAt,
      refreshToken: nextRefreshToken,
      refreshTokenExpiresAt: session.expiresAt,
    };
  }

  async listActiveSessions(userId: string): Promise<readonly AuthSessionRecord[]> {
    return this.sessionRepository.listActiveSessions({
      userId,
      now: this.clock.now(),
    });
  }

  async revokeSession(input: RevokeAuthSessionInput): Promise<boolean> {
    return this.sessionRepository.revokeSession({
      sessionId: input.sessionId,
      userId: input.userId,
      revokedAt: this.clock.now(),
    });
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<readonly string[]> {
    return this.sessionRepository.revokeOtherSessions({
      userId,
      currentSessionId,
      revokedAt: this.clock.now(),
    });
  }

  async updateLastUsedAt(sessionId: string): Promise<void> {
    const now = this.clock.now();
    const session = await this.sessionRepository.findSessionById(sessionId);

    if (session === null) {
      throw new InvalidTokenError();
    }

    this.assertSessionUsableAt(session, now);

    const updated = await this.sessionRepository.updateLastUsedAt(
      sessionId,
      now,
    );

    if (!updated) {
      throw new InvalidTokenError();
    }
  }

  assertSessionUsable(session: AuthSessionRecord): void {
    this.assertSessionUsableAt(session, this.clock.now());
  }

  private assertSessionUsableAt(session: AuthSessionRecord, now: Date): void {
    if (session.revokedAt !== null) {
      throw new SessionRevokedError();
    }

    if (isExpired(session.expiresAt, now)) {
      throw new SessionExpiredError();
    }
  }
}
