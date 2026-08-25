import {
  EmailAlreadyInUseError,
  InvalidCredentialsError,
  InvalidTokenError,
  UserAlreadyExistsError,
  UsernameAlreadyInUseError,
} from "./auth.errors.js";
import type {
  AuthRepository,
  CreateUserData,
  UserRecord,
  UserStatus,
} from "./auth.repository.js";
import { UserUniqueConstraintError } from "./auth.repository.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import { normalizeEmail } from "./auth.schema.js";
import type { AuthContext } from "./auth.types.js";
import type {
  CreatedAuthSession,
  FindActiveAuthSessionInput,
  RevokeAuthSessionInput,
  RotatedAuthSession,
} from "./sessions/auth-session.service.js";
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
  createSession(input: { userId: string }): Promise<CreatedAuthSession>;
  findActiveSessionForUser(
    input: FindActiveAuthSessionInput,
  ): Promise<unknown>;
  rotateRefreshToken(refreshToken: string): Promise<RotatedAuthSession>;
  revokeSession(input: RevokeAuthSessionInput): Promise<void>;
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

  constructor(dependencies: AuthServiceDependencies) {
    this.authRepository = dependencies.authRepository;
    this.authSessionService = dependencies.authSessionService;
    this.accessTokenVerifier = dependencies.accessTokenVerifier;
    this.passwordService = dependencies.passwordService;
    this.dummyPasswordHash = dependencies.dummyPasswordHash;
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

  async register(input: RegisterInput): Promise<AuthResult> {
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
    });

    return {
      user: toPublicUser(user),
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAt: session.refreshTokenExpiresAt,
    };
  }

  async login(input: LoginInput): Promise<AuthResult> {
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
    await this.authSessionService.revokeSession(input);
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
