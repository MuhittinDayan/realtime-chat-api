import type { Request, Response } from "express";

import { InvalidRefreshTokenError } from "./auth.errors.js";
import { requireAuthContext } from "./auth.middleware.js";
import type {
  AuthSessionParams,
  ChangePasswordInput,
  LoginInput,
  RegisterInput,
} from "./auth.schema.js";
import type {
  AuthRequestMetadata,
  AuthResult,
  ListAuthSessionsResult,
  PublicUser,
  RefreshResult,
} from "./auth.service.js";
import type { ValidatedBodyHandler } from "./auth.validation.js";
import type { RefreshCookieManager } from "./refresh-cookie.js";

export interface AuthHttpService {
  register(
    input: RegisterInput,
    metadata?: AuthRequestMetadata,
  ): Promise<AuthResult>;
  login(input: LoginInput, metadata?: AuthRequestMetadata): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
  logout(input: { sessionId: string; userId: string }): Promise<void>;
  getCurrentUser(userId: string): Promise<PublicUser>;
  changePassword(
    userId: string,
    sessionId: string,
    input: ChangePasswordInput,
  ): Promise<void>;
  listSessions(
    userId: string,
    sessionId: string,
  ): Promise<ListAuthSessionsResult>;
  revokeOwnedSession(userId: string, sessionId: string): Promise<boolean>;
  revokeOtherSessions(userId: string, sessionId: string): Promise<void>;
}

export interface AuthControllerDependencies {
  authService: AuthHttpService;
  refreshCookieManager: RefreshCookieManager;
}

export class AuthController {
  private readonly authService: AuthHttpService;
  private readonly refreshCookieManager: RefreshCookieManager;

  constructor(dependencies: AuthControllerDependencies) {
    this.authService = dependencies.authService;
    this.refreshCookieManager = dependencies.refreshCookieManager;
  }

  readonly register: ValidatedBodyHandler<RegisterInput> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.authService.register(
      input,
      requestMetadata(request),
    );

    this.setRefreshCookie(response, result);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({
      user: result.user,
      accessToken: result.accessToken,
    });
  };

  readonly login: ValidatedBodyHandler<LoginInput> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.authService.login(input, requestMetadata(request));

    this.setRefreshCookie(response, result);
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({
      user: result.user,
      accessToken: result.accessToken,
    });
  };

  readonly refresh = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const refreshToken = this.refreshCookieManager.read(request);

    if (refreshToken === null) {
      throw new InvalidRefreshTokenError();
    }

    const result = await this.authService.refresh(refreshToken);

    this.setRefreshCookie(response, result);
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ accessToken: result.accessToken });
  };

  readonly logout = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const auth = requireAuthContext(request);

    await this.authService.logout({
      sessionId: auth.sessionId,
      userId: auth.userId,
    });
    this.refreshCookieManager.clear(response);
    response.status(204).end();
  };

  readonly me = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const user = await this.authService.getCurrentUser(auth.userId);

    response.setHeader("Cache-Control", "no-store");
    response.status(200).json({ user });
  };

  readonly changePassword: ValidatedBodyHandler<ChangePasswordInput> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    await this.authService.changePassword(
      auth.userId,
      auth.sessionId,
      input,
    );
    response.status(204).end();
  };

  readonly listSessions = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const result = await this.authService.listSessions(
      auth.userId,
      auth.sessionId,
    );
    response.setHeader("Cache-Control", "no-store");
    response.status(200).json(result);
  };

  readonly revokeSession: ValidatedBodyHandler<AuthSessionParams> = async (
    request,
    response,
    input,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    const revoked = await this.authService.revokeOwnedSession(
      auth.userId,
      input.sessionId,
    );

    if (revoked && input.sessionId === auth.sessionId) {
      this.refreshCookieManager.clear(response);
    }

    response.status(204).end();
  };

  readonly revokeOtherSessions = async (
    request: Request,
    response: Response,
  ): Promise<void> => {
    const auth = requireAuthContext(request);
    await this.authService.revokeOtherSessions(auth.userId, auth.sessionId);
    response.status(204).end();
  };

  private setRefreshCookie(
    response: Response,
    result: RefreshResult,
  ): void {
    this.refreshCookieManager.set(response, {
      token: result.refreshToken,
      expiresAt: result.refreshTokenExpiresAt,
    });
  }
}

function requestMetadata(request: Request): AuthRequestMetadata {
  const userAgent = request.get("user-agent");

  return {
    userAgent: userAgent === undefined || userAgent === "" ? null : userAgent,
  };
}
