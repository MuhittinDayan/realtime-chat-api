import type { PrismaClient } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";

export interface PresenceUserRecord {
  id: string;
  lastSeenAt: Date | null;
}

export interface PresenceRepository {
  findDirectPeerIds(userId: string): Promise<readonly string[]>;
  findAuthorizedUsers(
    requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<readonly PresenceUserRecord[]>;
  updateLastSeen(userId: string, lastSeenAt: Date): Promise<Date>;
}

function directPeerFilter(userId: string) {
  return {
    conversationMembers: {
      some: {
        leftAt: null,
        conversation: {
          type: "DIRECT" as const,
          members: { some: { userId, leftAt: null } },
        },
      },
    },
  };
}

export class PrismaPresenceRepository implements PresenceRepository {
  constructor(private readonly client: PrismaClient = prisma) {}

  async findDirectPeerIds(userId: string): Promise<readonly string[]> {
    const peers = await this.client.user.findMany({
      where: {
        id: { not: userId },
        ...directPeerFilter(userId),
      },
      select: { id: true },
    });

    return peers.map((peer) => peer.id);
  }

  async findAuthorizedUsers(
    requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<readonly PresenceUserRecord[]> {
    if (requestedUserIds.length === 0) {
      return [];
    }

    return this.client.user.findMany({
      where: {
        id: { in: [...requestedUserIds], not: requesterId },
        ...directPeerFilter(requesterId),
      },
      select: { id: true, lastSeenAt: true },
    });
  }

  async updateLastSeen(userId: string, lastSeenAt: Date): Promise<Date> {
    const user = await this.client.user.update({
      where: { id: userId },
      data: { lastSeenAt },
      select: { lastSeenAt: true },
    });

    if (user.lastSeenAt === null) {
      throw new Error("lastSeenAt update returned null");
    }

    return user.lastSeenAt;
  }
}
