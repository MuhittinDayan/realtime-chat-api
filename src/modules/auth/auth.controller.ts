import type { Request, Response } from "express";

import { InvalidRefreshTokenError } from "./auth.errors.js";
import { requireAuthContext } from "./auth.middleware.js";
import type { LoginInput, RegisterInput } from "./auth.schema.js";
import type {
  AuthResult,
  PublicUser,
  RefreshResult,
} from "./auth.service.js";
import type { ValidatedBodyHandler } from "./auth.validation.js";
import type { RefreshCookieManager } from "./refresh-cookie.js";

export interface AuthHttpService {
  register(input: RegisterInput): Promise<AuthResult>;
  login(input: LoginInput): Promise<AuthResult>;
  refresh(refreshToken: string): Promise<RefreshResult>;
  logout(input: { sessionId: string; userId: string }): Promise<void>;
  getCurrentUser(userId: string): Promise<PublicUser>;
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
    _request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.authService.register(input);

    this.setRefreshCookie(response, result);
    response.setHeader("Cache-Control", "no-store");
    response.status(201).json({
      user: result.user,
      accessToken: result.accessToken,
    });
  };

  readonly login: ValidatedBodyHandler<LoginInput> = async (
    _request,
    response,
    input,
  ): Promise<void> => {
    const result = await this.authService.login(input);

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
