import type { Request, RequestHandler } from "express";
import { HOUR, MINUTE, ipKeyGenerator, rateLimit } from "express-rate-limit";

import { AppError } from "../../shared/errors/app-error.js";

export interface HttpRateLimitPolicy {
  identifier: string;
  windowMs: number;
  limit: number;
  scope: "ip" | "user";
}

export const httpRateLimitPolicies = Object.freeze({
  login: {
    identifier: "auth-login",
    windowMs: 15 * MINUTE,
    limit: 10,
    scope: "ip",
  },
  register: {
    identifier: "auth-register",
    windowMs: HOUR,
    limit: 5,
    scope: "ip",
  },
  refresh: {
    identifier: "auth-refresh",
    windowMs: 5 * MINUTE,
    limit: 30,
    scope: "ip",
  },
  passwordChange: {
    identifier: "auth-password-change",
    windowMs: 15 * MINUTE,
    limit: 10,
    scope: "user",
  },
  userSearch: {
    identifier: "user-search",
    windowMs: MINUTE,
    limit: 60,
    scope: "user",
  },
  messageCreate: {
    identifier: "message-create",
    windowMs: MINUTE,
    limit: 60,
    scope: "user",
  },
} satisfies Record<string, HttpRateLimitPolicy>);

export class RateLimitExceededError extends AppError {
  constructor() {
    super({
      statusCode: 429,
      code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests",
    });
  }
}

function userOrIpKey(request: Request): string {
  return (
    request.auth?.userId ??
    ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "unknown")
  );
}

export function createHttpRateLimiter(
  policy: HttpRateLimitPolicy,
): RequestHandler {
  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    identifier: policy.identifier,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    ...(policy.scope === "user" ? { keyGenerator: userOrIpKey } : {}),
    handler: (_request, _response, next) => {
      next(new RateLimitExceededError());
    },
  });
}

// Login remains intentionally IP-scoped for this MVP. Shared NAT/CGNAT clients
// consume the same bucket; a future policy may add a username+IP signal without
// removing the coarse IP bucket.
export const loginRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.login,
);
export const registerRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.register,
);
export const refreshRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.refresh,
);
export const passwordChangeRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.passwordChange,
);
export const userSearchRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.userSearch,
);
export const messageCreateRateLimit = createHttpRateLimiter(
  httpRateLimitPolicies.messageCreate,
);
