import { describe, expect, it } from "vitest";

import {
  generateRefreshToken,
  hashRefreshToken,
} from "./refresh-token.service.js";

describe("refresh token service", () => {
  it("produces a deterministic SHA-256 hash", () => {
    const token = "rt_test-token";

    expect(hashRefreshToken(token)).toBe(
      "3b9355873326f3277afec21218e1756a540ae8ed0c971f02e11a7810f2ab3982",
    );
    expect(hashRefreshToken(token)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("produces different hashes for different refresh tokens", () => {
    expect(hashRefreshToken("rt_token-a")).not.toBe(
      hashRefreshToken("rt_token-b"),
    );
  });

  it("generates distinct opaque refresh tokens", () => {
    const firstToken = generateRefreshToken();
    const secondToken = generateRefreshToken();

    expect(firstToken).toMatch(/^rt_[A-Za-z0-9_-]{43}$/u);
    expect(secondToken).not.toBe(firstToken);
  });
});
