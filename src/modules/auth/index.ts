export {
  accessTokenService,
  authRepository,
  authService,
  authSessionRepository,
  authSessionService,
} from "./auth-core.js";
export {
  AuthenticationRequiredError,
  CsrfValidationError,
  EmailAlreadyInUseError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
  InvalidTokenError,
  RequestValidationError,
  SessionExpiredError,
  SessionRevokedError,
  UserAlreadyExistsError,
  UsernameAlreadyInUseError,
} from "./auth.errors.js";
export { PrismaAuthRepository } from "./auth.repository.js";
export type {
  AuthRepository,
  AuthUserRecord,
  CreateUserData,
  UserRecord,
} from "./auth.repository.js";
export { AuthService } from "./auth.service.js";
export type {
  AuthResult,
  AuthServiceDependencies,
  PublicUser,
  RefreshResult,
} from "./auth.service.js";
export {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password/password.service.js";
export { PrismaAuthSessionRepository } from "./sessions/auth-session.repository.js";
export { AuthSessionService } from "./sessions/auth-session.service.js";
export type {
  AuthSessionServiceDependencies,
  CreatedAuthSession,
  CreateAuthSessionInput,
  RevokeAuthSessionInput,
  RotatedAuthSession,
} from "./sessions/auth-session.service.js";
export type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionData,
  RevokeAuthSessionData,
  RotateRefreshTokenData,
} from "./sessions/auth-session.types.js";
export {
  AccessTokenService,
  type AccessTokenConfig,
  type AccessTokenIssuer,
  type AccessTokenPayload,
  type CreateAccessTokenInput,
  type IssuedAccessToken,
} from "./tokens/access-token.service.js";
export {
  generateRefreshToken,
  hashRefreshToken,
  type RefreshTokenCodec,
} from "./tokens/refresh-token.service.js";
