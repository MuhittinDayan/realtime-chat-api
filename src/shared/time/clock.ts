export interface Clock {
  now(): Date;
}

export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function toUnixTimeSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}
