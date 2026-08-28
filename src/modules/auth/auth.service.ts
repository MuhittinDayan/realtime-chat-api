import {
  EmailAlreadyInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  UserAlreadyExistsError,
  UsernameAlreadyInUseError,
} from "./auth.errors.js";
import { RequestValidationError } from "../../shared/errors/request-validation-error.js";
import type {
  AuthRepository,
  CreateUserData,
  UserRecord,
  UserStatus,
} from "./auth.repository.js";
import { UserUniqueConstraintError } from "./auth.repository.js";
import type {
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
} from "./auth.schema.js";
import { normalizeEmail } from "./auth.schema.js";
import type { AuthContext } from "./auth.types.js";
import type {
  CreatedAuthSession,
  FindActiveAuthSessionInput,
  RevokeAuthSessionInput,
  RotatedAuthSession,
} from "./sessions/auth-session.service.js";
import type { AuthSessionRecord } from "./sessions/auth-session.types.js";
import type { AccessTokenPayload } from "./tokens/access-token.service.js";

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

const noopSessionRevocationPublisher: SessionRevocationPublisher = {
  publishRevoked: () => undefined,
};

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

function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    status: user.status,
    createdAt: user.createdAt,
  };
}

function ensureActiveUser(user: UserRecord | null): UserRecord {
  if (
    user === null ||
    user.status !== "ACTIVE" ||
    user.deletedAt !== null
  ) {
    throw new InvalidTokenError();
  }

  return user;
}

export class AuthService {
  private readonly authRepository: AuthRepository;
  private readonly authSessionService: AuthSessionManager;
  private readonly accessTokenVerifier: AccessTokenVerifier;
  private readonly passwordService: PasswordService;
  private readonly dummyPasswordHash: string;
  private readonly sessionRevocationPublisher: SessionRevocationPublisher;

  constructor(dependencies: AuthServiceDependencies) {
    this.authRepository = dependencies.authRepository;
    this.authSessionService = dependencies.authSessionService;
    this.accessTokenVerifier = dependencies.accessTokenVerifier;
    this.passwordService = dependencies.passwordService;
    this.dummyPasswordHash = dependencies.dummyPasswordHash;
    this.sessionRevocationPublisher =
      dependencies.sessionRevocationPublisher ?? noopSessionRevocationPublisher;
  }

  async authenticateAccessToken(token: string): Promise<AuthContext> {
    const payload = await this.accessTokenVerifier.verifyAccessToken(token);

    await this.authSessionService.findActiveSessionForUser({
      sessionId: payload.sid,
      userId: payload.sub,
    });

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      jwtId: payload.jti,
    };
  }

  async register(
    input: RegisterInput,
    metadata: AuthRequestMetadata = { userAgent: null },
  ): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const [existingEmail, existingUsername] = await Promise.all([
      this.authRepository.findUserByEmail(email),
      this.authRepository.findUserByUsername(input.username),
    ]);

    if (existingEmail !== null) {
      throw new EmailAlreadyInUseError();
    }

    if (existingUsername !== null) {
      throw new UsernameAlreadyInUseError();
    }

    const passwordHash = await this.passwordService.hashPassword(
      input.password,
    );
    const createUserData: CreateUserData = {
      email,
      username: input.username,
      displayName: input.displayName,
      passwordHash,
      status: "ACTIVE",
    };
    let user: UserRecord;

    try {
      user = await this.authRepository.createUser(createUserData);
    } catch (error: unknown) {
      this.handleCreateUserError(error);
    }

    const session = await this.authSessionService.createSession({
      userId: user.id,
      userAgent: metadata.userAgent,
    });

    return {
      user: toPublicUser(user),
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  async login(
    input: LoginInput,
    metadata: AuthRequestMetadata = { userAgent: null },
  ): Promise<AuthResult> {
    const user = await this.authRepository.findUserByEmail(
      normalizeEmail(input.email),
    );
    const passwordMatches = await this.passwordService.verifyPassword(
      user?.passwordHash ?? this.dummyPasswordHash,
      input.password,
    );

    if (
      user === null ||
      !passwordMatches ||
      user.status !== "ACTIVE" ||
      user.deletedAt !== null
    ) {
      throw new InvalidCredentialsError();
    }

    const session = await this.authSessionService.createSession({
      userId: user.id,
      userAgent: metadata.userAgent,
    });

    return {
      user: toPublicUser(user),
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  async refresh(refreshToken: string): Promise<RefreshResult> {
    const session =
      await this.authSessionService.rotateRefreshToken(refreshToken);

    return {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  async logout(input: RevokeAuthSessionInput): Promise<void> {
    if (await this.authSessionService.revokeSession(input)) {
      await this.sessionRevocationPublisher.publishRevoked([input.sessionId]);
    }
  }

  async changePassword(
    currentUserId: string,
    currentSessionId: string,
    input: ChangePasswordInput,
  ): Promise<void> {
    const user = await this.authRepository.findAuthUserById(currentUserId);

    if (
      user === null ||
      user.status !== "ACTIVE" ||
      user.deletedAt !== null
    ) {
      throw new InvalidTokenError();
    }

    const currentPasswordMatches = await this.passwordService.verifyPassword(
      user.passwordHash,
      input.currentPassword,
    );

    if (!currentPasswordMatches) {
      throw new InvalidCredentialsError();
    }

    if (input.currentPassword === input.newPassword) {
      throw new RequestValidationError([
        {
          path: "body.newPassword",
          message: "New password must be different from current password",
        },
      ]);
    }

    const passwordHash = await this.passwordService.hashPassword(
      input.newPassword,
    );
    const updated = await this.authRepository.updatePassword(
      currentUserId,
      passwordHash,
    );

    if (!updated) {
      throw new InvalidTokenError();
    }

    await this.revokeOtherSessions(currentUserId, currentSessionId);
  }

  async listSessions(
    currentUserId: string,
    currentSessionId: string,
  ): Promise<ListAuthSessionsResult> {
    const sessions = await this.authSessionService.listActiveSessions(
      currentUserId,
    );

    return {
      items: sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        isCurrent: session.id === currentSessionId,
      })),
    };
  }

  async revokeOwnedSession(
    currentUserId: string,
    sessionId: string,
  ): Promise<boolean> {
    const revoked = await this.authSessionService.revokeSession({
      userId: currentUserId,
      sessionId,
    });

    if (revoked) {
      await this.sessionRevocationPublisher.publishRevoked([sessionId]);
    }

    return revoked;
  }

  async revokeOtherSessions(
    currentUserId: string,
    currentSessionId: string,
  ): Promise<void> {
    const revokedSessionIds =
      await this.authSessionService.revokeOtherSessions(
        currentUserId,
        currentSessionId,
      );
    await this.sessionRevocationPublisher.publishRevoked(revokedSessionIds);
  }

  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = ensureActiveUser(
      await this.authRepository.findUserById(userId),
    );

    return toPublicUser(user);
  }

  private handleCreateUserError(error: unknown): never {
    if (!(error instanceof UserUniqueConstraintError)) {
      throw error;
    }

    if (error.fields.includes("email")) {
      throw new EmailAlreadyInUseError();
    }

    if (error.fields.includes("username")) {
      throw new UsernameAlreadyInUseError();
    }

    throw new UserAlreadyExistsError(error);
  }
}
