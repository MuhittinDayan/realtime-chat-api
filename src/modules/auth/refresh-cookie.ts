import { parseCookie } from "cookie";
import type { CookieOptions, Request, Response } from "express";

import type { Clock } from "../../shared/time/clock.js";
import { systemClock } from "../../shared/time/clock.js";
import {
  REFRESH_TOKEN_COOKIE_NAME,
  REFRESH_TOKEN_COOKIE_PATH,
} from "./auth.constants.js";

export interface RefreshCookieManagerOptions {
  secure: boolean;
  clock?: Clock;
}

export interface RefreshCookieValue {
  token: string;
  expiresAt: Date;
}

export interface RefreshCookieManager {
  read(request: Request): string | null;
  set(response: Response, value: RefreshCookieValue): void;
  clear(response: Response): void;
}

const baseCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  path: REFRESH_TOKEN_COOKIE_PATH,
} satisfies CookieOptions;

export class HttpRefreshCookieManager implements RefreshCookieManager {
  private readonly secure: boolean;
  private readonly clock: Clock;

  constructor(options: RefreshCookieManagerOptions) {
    this.secure = options.secure;
    this.clock = options.clock ?? systemClock;
  }

  read(request: Request): string | null {
    const cookieHeader = request.get("cookie");

    if (cookieHeader === undefined) {
      return null;
    }

    return parseCookie(cookieHeader)[REFRESH_TOKEN_COOKIE_NAME] ?? null;
  }

  set(response: Response, value: RefreshCookieValue): void {
    const maxAge = Math.max(
      0,
      value.expiresAt.getTime() - this.clock.now().getTime(),
    );

    response.cookie(REFRESH_TOKEN_COOKIE_NAME, value.token, {
      ...baseCookieOptions,
      secure: this.secure,
      expires: value.expiresAt,
      maxAge,
    });
  }

  clear(response: Response): void {
    response.clearCookie(REFRESH_TOKEN_COOKIE_NAME, {
      ...baseCookieOptions,
      secure: this.secure,
    });
  }
}
