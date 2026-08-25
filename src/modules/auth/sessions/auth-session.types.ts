export interface AuthSessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface CreateAuthSessionData {
  id: string;
  userId: string;
  refreshTokenHash: string;
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

export interface AuthSessionRepository {
  createSession(data: CreateAuthSessionData): Promise<AuthSessionRecord>;
  findSessionById(sessionId: string): Promise<AuthSessionRecord | null>;
  findActiveSessionById(
    data: FindActiveAuthSessionData,
  ): Promise<AuthSessionRecord | null>;
  findSessionByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<AuthSessionRecord | null>;
  rotateRefreshToken(data: RotateRefreshTokenData): Promise<boolean>;
  revokeSession(data: RevokeAuthSessionData): Promise<void>;
  updateLastUsedAt(sessionId: string, lastUsedAt: Date): Promise<boolean>;
}
