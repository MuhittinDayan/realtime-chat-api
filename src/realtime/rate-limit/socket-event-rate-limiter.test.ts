import { describe, expect, it } from "vitest";

import {
  SocketEventRateLimiter,
  typingRateLimitPolicy,
} from "./socket-event-rate-limiter.js";

describe("SocketEventRateLimiter", () => {
  it("keeps the approved typing limit explicit", () => {
    expect(typingRateLimitPolicy).toEqual({ windowMs: 5_000, limit: 20 });
  });

  it("uses a sliding window and accepts events again after expiry", () => {
    const limiter = new SocketEventRateLimiter({ windowMs: 5_000, limit: 2 });

    expect(limiter.tryAcquire(new Date(1_000))).toBe(true);
    expect(limiter.tryAcquire(new Date(2_000))).toBe(true);
    expect(limiter.tryAcquire(new Date(3_000))).toBe(false);
    expect(limiter.tryAcquire(new Date(6_000))).toBe(true);
  });
});
