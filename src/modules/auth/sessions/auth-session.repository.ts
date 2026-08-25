import type { PrismaClient } from "../../../generated/prisma/client.js";
import { prisma } from "../../../infrastructure/database/prisma.js";
import type {
  AuthSessionRecord,
  AuthSessionRepository,
  CreateAuthSessionData,
  FindActiveAuthSessionData,
  RevokeAuthSessionData,
  RotateRefreshTokenData,
} from "./auth-session.types.js";

const authSessionSelect = {
  id: true,
  userId: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export class PrismaAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async createSession(data: CreateAuthSessionData): Promise<AuthSessionRecord> {
    return this.client.authSession.create({
      data: {
        id: data.id,
        userId: data.userId,
        refreshTokenHash: data.refreshTokenHash,
        expiresAt: data.expiresAt,
        lastUsedAt: data.lastUsedAt,
      },
      select: authSessionSelect,
    });
  }

  async findSessionById(sessionId: string): Promise<AuthSessionRecord | null> {
    return this.client.authSession.findUnique({
      where: { id: sessionId },
      select: authSessionSelect,
    });
  }

  async findActiveSessionById(
    data: FindActiveAuthSessionData,
  ): Promise<AuthSessionRecord | null> {
    return this.client.authSession.findFirst({
      where: {
        id: data.sessionId,
        userId: data.userId,
        revokedAt: null,
        expiresAt: { gt: data.now },
        user: {
          is: {
            status: "ACTIVE",
            deletedAt: null,
          },
        },
      },
      select: authSessionSelect,
    });
  }

  async findSessionByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<AuthSessionRecord | null> {
    return this.client.authSession.findUnique({
      where: { refreshTokenHash },
      select: authSessionSelect,
    });
  }

  async rotateRefreshToken(data: RotateRefreshTokenData): Promise<boolean> {
    const result = await this.client.authSession.updateMany({
      where: {
        id: data.sessionId,
        userId: data.userId,
        refreshTokenHash: data.currentRefreshTokenHash,
        revokedAt: null,
        expiresAt: { gt: data.rotatedAt },
        lastUsedAt: { lte: data.rotatedAt },
        user: {
          is: {
            status: "ACTIVE",
            deletedAt: null,
          },
        },
      },
      data: {
        refreshTokenHash: data.nextRefreshTokenHash,
        lastUsedAt: data.rotatedAt,
      },
    });

    return result.count === 1;
  }

  async revokeSession(data: RevokeAuthSessionData): Promise<void> {
    await this.client.authSession.updateMany({
      where: {
        id: data.sessionId,
        userId: data.userId,
        revokedAt: null,
      },
      data: { revokedAt: data.revokedAt },
    });
  }

  async updateLastUsedAt(
    sessionId: string,
    lastUsedAt: Date,
  ): Promise<boolean> {
    const result = await this.client.authSession.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        expiresAt: { gt: lastUsedAt },
        lastUsedAt: { lte: lastUsedAt },
      },
      data: { lastUsedAt },
    });

    return result.count === 1;
  }
}
