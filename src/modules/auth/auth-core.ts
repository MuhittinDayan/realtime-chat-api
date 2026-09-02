import { env } from "../../config/env.js";
import { socketSessionRevocationPublisher } from "../../realtime/auth/session-revocation-publisher.js";
import { systemClock } from "../../shared/time/clock.js";
import { AuthService } from "./application/auth.service.js";
import { PrismaAuthRepository } from "./persistence/auth.repository.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "./password/password.service.js";
import { PrismaAuthSessionRepository } from "./sessions/auth-session.repository.js";
import { AuthSessionService } from "./sessions/auth-session.service.js";
import { AccessTokenService } from "./tokens/access-token.service.js";

export const accessTokenService = new AccessTokenService(
  {
    secret: env.JWT_ACCESS_SECRET,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ttlMinutes: env.ACCESS_TOKEN_TTL_MINUTES,
  },
  systemClock,
);

export const authSessionRepository = new PrismaAuthSessionRepository();

export const authSessionService = new AuthSessionService({
  sessionRepository: authSessionRepository,
  accessTokenService,
  refreshTokenTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
  clock: systemClock,
});

export const authRepository = new PrismaAuthRepository();

export const authService = new AuthService({
  authRepository,
  authSessionService,
  accessTokenVerifier: accessTokenService,
  passwordService: {
    hashPassword,
    verifyPassword,
  },
  dummyPasswordHash: DUMMY_PASSWORD_HASH,
  sessionRevocationPublisher: socketSessionRevocationPublisher,
});
