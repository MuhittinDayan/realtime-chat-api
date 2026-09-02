import { randomUUID } from "node:crypto";

import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { z, ZodError } from "zod";

import type { Clock } from "../../../shared/time/clock.js";
import {
  systemClock,
  toUnixTimeSeconds,
} from "../../../shared/time/clock.js";
import { InvalidTokenError } from "../domain/auth.errors.js";

const ACCESS_TOKEN_ALGORITHM = "HS256";
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_ACCESS_TOKEN_TTL_MINUTES = 60;

const createAccessTokenInputSchema = z.object({
  userId: z.string().uuid(),
  sessionId: z.string().uuid(),
});

const accessTokenPayloadSchema = z
  .object({
    sub: z.string().uuid(),
    sid: z.string().uuid(),
    jti: z.string().uuid(),
    iss: z.string().min(1),
    aud: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .refine((payload) => payload.exp > payload.iat, {
    message: "Token expiration must be after its issue time",
  });

export type AccessTokenPayload = z.infer<typeof accessTokenPayloadSchema>;

export interface AccessTokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlMinutes: number;
}

export interface CreateAccessTokenInput {
  userId: string;
  sessionId: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface AccessTokenIssuer {
  createAccessToken(input: CreateAccessTokenInput): Promise<IssuedAccessToken>;
}

export class AccessTokenService implements AccessTokenIssuer {
  private readonly signingKey: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlMinutes: number;
  private readonly clock: Clock;

  constructor(config: AccessTokenConfig, clock: Clock = systemClock) {
    const signingKey = new TextEncoder().encode(config.secret);

    if (signingKey.byteLength < MINIMUM_SECRET_BYTES) {
      throw new RangeError("JWT access secret must be at least 32 bytes");
    }

    if (config.issuer.trim().length === 0) {
      throw new RangeError("JWT issuer must not be empty");
    }

    if (config.audience.trim().length === 0) {
      throw new RangeError("JWT audience must not be empty");
    }

    if (
      !Number.isSafeInteger(config.ttlMinutes) ||
      config.ttlMinutes <= 0 ||
      config.ttlMinutes > MAXIMUM_ACCESS_TOKEN_TTL_MINUTES
    ) {
      throw new RangeError(
        "Access token TTL must be an integer between 1 and 60 minutes",
      );
    }

    this.signingKey = signingKey;
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.ttlMinutes = config.ttlMinutes;
    this.clock = clock;
  }

  async createAccessToken(
    input: CreateAccessTokenInput,
  ): Promise<IssuedAccessToken> {
    const parsedInput = createAccessTokenInputSchema.parse(input);
    const issuedAt = toUnixTimeSeconds(this.clock.now());
    const expiresAt = issuedAt + this.ttlMinutes * 60;
    const token = await new SignJWT({ sid: parsedInput.sessionId })
      .setProtectedHeader({ alg: ACCESS_TOKEN_ALGORITHM, typ: "JWT" })
      .setSubject(parsedInput.userId)
      .setJti(randomUUID())
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(this.signingKey);

    return {
      token,
      expiresAt: new Date(expiresAt * 1_000),
    };
  }

  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const { payload } = await jwtVerify(token, this.signingKey, {
        algorithms: [ACCESS_TOKEN_ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        typ: "JWT",
        requiredClaims: ["sub", "sid", "jti", "iss", "aud", "iat", "exp"],
        currentDate: this.clock.now(),
      });

      return accessTokenPayloadSchema.parse(payload);
    } catch (error: unknown) {
      if (
        error instanceof joseErrors.JOSEError ||
        error instanceof ZodError
      ) {
        throw new InvalidTokenError(error);
      }

      throw error;
    }
  }
}
