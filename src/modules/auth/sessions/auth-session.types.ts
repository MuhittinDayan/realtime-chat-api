export interface AuthSessionRecord {
  id: string;
  userId: string;
  userAgent: string | null;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateAuthSessionData {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  expiresAt: Date;
  lastUsedAt: Date;
}

export interface RotateRefreshTokenData {
  sessionId: string;
  userId: string;
  currentRefreshTokenHash: string;
  nextRefreshTokenHash: string;
  rotatedAt: Date;
}

export interface RevokeAuthSessionData {
  sessionId: string;
  userId: string;
  revokedAt: Date;
}

export interface FindActiveAuthSessionData {
  sessionId: string;
  userId: string;
  now: Date;
}

export interface ListActiveAuthSessionsData {
  userId: string;
  now: Date;
}

export interface RevokeOtherAuthSessionsData {
  userId: string;
  currentSessionId: string;
  revokedAt: Date;
}

export interface AuthSessionRepository {
  createSession(data: CreateAuthSessionData): Promise<AuthSessionRecord>;
  findSessionById(sessionId: string): Promise<AuthSessionRecord | null>;
  findActiveSessionById(
    data: FindActiveAuthSessionData,
  ): Promise<AuthSessionRecord | null>;
  findSessionByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<AuthSessionRecord | null>;
  listActiveSessions(
    data: ListActiveAuthSessionsData,
  ): Promise<readonly AuthSessionRecord[]>;
  rotateRefreshToken(data: RotateRefreshTokenData): Promise<boolean>;
  revokeSession(data: RevokeAuthSessionData): Promise<boolean>;
  revokeOtherSessions(
    data: RevokeOtherAuthSessionsData,
  ): Promise<readonly string[]>;
  updateLastUsedAt(sessionId: string, lastUsedAt: Date): Promise<boolean>;
}
