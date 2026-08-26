import { describe, expect, it } from "vitest";

import { httpRateLimitPolicies } from "./rate-limit.js";

describe("HTTP rate-limit policies", () => {
  it("keeps the approved endpoint limits explicit", () => {
    expect(httpRateLimitPolicies).toEqual({
      login: {
        identifier: "auth-login",
        windowMs: 15 * 60_000,
        limit: 10,
        scope: "ip",
      },
      register: {
        identifier: "auth-register",
        windowMs: 60 * 60_000,
        limit: 5,
        scope: "ip",
      },
      refresh: {
        identifier: "auth-refresh",
        windowMs: 5 * 60_000,
        limit: 30,
        scope: "ip",
      },
      userSearch: {
        identifier: "user-search",
        windowMs: 60_000,
        limit: 60,
        scope: "user",
      },
      messageCreate: {
        identifier: "message-create",
        windowMs: 60_000,
        limit: 60,
        scope: "user",
      },
    });
  });
});
