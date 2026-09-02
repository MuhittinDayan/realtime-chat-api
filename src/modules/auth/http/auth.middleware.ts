import type { Request, RequestHandler } from "express";

import { AppError } from "../../../shared/errors/app-error.js";
import {
  AuthenticationRequiredError,
  CsrfValidationError,
} from "../domain/auth.errors.js";
import type { AuthContext } from "../domain/auth.types.js";

const BEARER_TOKEN_PATTERN = /^Bearer ([^\s,]+)$/iu;
const WWW_AUTHENTICATE_VALUE = 'Bearer realm="chat-api"';

export interface AccessAuthenticator {
  authenticateAccessToken(token: string): Promise<AuthContext>;
}

export interface TrustedOriginOptions {
  trustedOrigin: string;
  enforce: boolean;
}

export function createAuthenticationMiddleware(
  accessAuthenticator: AccessAuthenticator,
): RequestHandler {
  return async (request, response, next): Promise<void> => {
    const authorization = request.get("authorization");
    const match =
      authorization === undefined
        ? null
        : BEARER_TOKEN_PATTERN.exec(authorization);

    if (match === null) {
      response.setHeader("WWW-Authenticate", WWW_AUTHENTICATE_VALUE);
      throw new AuthenticationRequiredError();
    }

    const token = match[1];

    if (token === undefined) {
      response.setHeader("WWW-Authenticate", WWW_AUTHENTICATE_VALUE);
      throw new AuthenticationRequiredError();
    }

    let auth: AuthContext;

    try {
      auth = await accessAuthenticator.authenticateAccessToken(token);
    } catch (error: unknown) {
      if (error instanceof AppError && error.statusCode === 401) {
        response.setHeader("WWW-Authenticate", WWW_AUTHENTICATE_VALUE);
      }

      throw error;
    }

    request.auth = auth;
    next();
  };
}

export function requireAuthContext(request: Request): AuthContext {
  if (request.auth === undefined) {
    throw new AuthenticationRequiredError();
  }

  return request.auth;
}

export function createTrustedOriginMiddleware(
  options: TrustedOriginOptions,
): RequestHandler {
  return (request, _response, next): void => {
    if (!options.enforce) {
      next();
      return;
    }

    const origin = request.get("origin");

    if (origin !== options.trustedOrigin) {
      next(new CsrfValidationError());
      return;
    }

    next();
  };
}
