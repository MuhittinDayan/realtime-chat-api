import type { AuthRepository, UserStatus } from "../persistence/auth.repository.js";
import type {
  CreatedAuthSession,
  FindActiveAuthSessionInput,
  RevokeAuthSessionInput,
  RotatedAuthSession,
} from "../sessions/auth-session.service.js";
import type { AuthSessionRecord } from "../sessions/auth-session.types.js";
import type { AccessTokenPayload } from "../tokens/access-token.service.js";

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  status: UserStatus;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface RefreshResult {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface PasswordService {
  hashPassword(password: string): Promise<string>;
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
}

export interface AuthSessionManager {
  createSession(input: {
    userId: string;
    userAgent: string | null;
  }): Promise<CreatedAuthSession>;
  findActiveSessionForUser(
    input: FindActiveAuthSessionInput,
  ): Promise<unknown>;
  rotateRefreshToken(refreshToken: string): Promise<RotatedAuthSession>;
  listActiveSessions(userId: string): Promise<readonly AuthSessionRecord[]>;
  revokeSession(input: RevokeAuthSessionInput): Promise<boolean>;
  revokeOtherSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<readonly string[]>;
}

export interface SessionRevocationPublisher {
  publishRevoked(sessionIds: readonly string[]): Promise<void> | void;
}

export interface AuthRequestMetadata {
  userAgent: string | null;
}

export interface AuthSessionDto {
  id: string;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export interface ListAuthSessionsResult {
  items: readonly AuthSessionDto[];
}

export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AccessTokenPayload>;
}

export interface AuthServiceDependencies {
  authRepository: AuthRepository;
  authSessionService: AuthSessionManager;
  accessTokenVerifier: AccessTokenVerifier;
  passwordService: PasswordService;
  dummyPasswordHash: string;
  sessionRevocationPublisher?: SessionRevocationPublisher;
}
