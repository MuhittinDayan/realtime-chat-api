export interface SocketEventRateLimitPolicy {
  windowMs: number;
  limit: number;
}

export const typingRateLimitPolicy = Object.freeze({
  windowMs: 5_000,
  limit: 20,
} satisfies SocketEventRateLimitPolicy);

export class SocketEventRateLimiter {
  readonly #policy: SocketEventRateLimitPolicy;
  readonly #acceptedAt: number[] = [];

  constructor(policy: SocketEventRateLimitPolicy) {
    this.#policy = policy;
  }

  tryAcquire(now: Date): boolean {
    const cutoff = now.getTime() - this.#policy.windowMs;

    while (
      this.#acceptedAt[0] !== undefined &&
      this.#acceptedAt[0] <= cutoff
    ) {
      this.#acceptedAt.shift();
    }

    if (this.#acceptedAt.length >= this.#policy.limit) {
      return false;
    }

    this.#acceptedAt.push(now.getTime());
    return true;
  }
}
