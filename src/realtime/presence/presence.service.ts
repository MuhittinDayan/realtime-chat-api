import type { Clock } from "../../shared/time/clock.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type {
  PresenceRepository,
  PresenceUserRecord,
} from "./presence.repository.js";

export interface PresenceUpdatedEvent {
  userId: string;
  status: "online" | "offline";
  lastSeenAt: Date | null;
}

export interface PresenceSnapshotItem {
  status: "online" | "offline";
  lastSeenAt: string | null;
}

export type PresenceSnapshot = Record<string, PresenceSnapshotItem>;

export interface PresencePublisher {
  publishToUsers(
    userIds: readonly string[],
    event: PresenceUpdatedEvent,
  ): Promise<void> | void;
}

export interface PresenceLifecycleService {
  handleConnected(userId: string, socketId: string): Promise<void>;
  handleDisconnected(userId: string, socketId: string): Promise<void>;
  getSnapshot(
    requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<PresenceSnapshot>;
}

export class PresenceService implements PresenceLifecycleService {
  constructor(
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly presenceRepository: PresenceRepository,
    private readonly presencePublisher: PresencePublisher,
    private readonly clock: Clock,
  ) {}

  async handleConnected(userId: string, socketId: string): Promise<void> {
    if (!this.connectionRegistry.add(userId, socketId)) {
      return;
    }

    const peerIds = await this.presenceRepository.findDirectPeerIds(userId);
    await this.presencePublisher.publishToUsers(peerIds, {
      userId,
      status: "online",
      lastSeenAt: null,
    });
  }

  async handleDisconnected(userId: string, socketId: string): Promise<void> {
    if (!this.connectionRegistry.remove(userId, socketId)) {
      return;
    }

    const lastSeenAt = await this.presenceRepository.updateLastSeen(
      userId,
      this.clock.now(),
    );

    if (this.connectionRegistry.isOnline(userId)) {
      return;
    }

    const peerIds = await this.presenceRepository.findDirectPeerIds(userId);
    await this.presencePublisher.publishToUsers(peerIds, {
      userId,
      status: "offline",
      lastSeenAt,
    });
  }

  async getSnapshot(
    requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<PresenceSnapshot> {
    const uniqueUserIds = [...new Set(requestedUserIds)];
    const authorizedUsers =
      await this.presenceRepository.findAuthorizedUsers(
        requesterId,
        uniqueUserIds,
      );

    return Object.fromEntries(
      authorizedUsers.map((user) => [
        user.id,
        toSnapshotItem(user, this.connectionRegistry.isOnline(user.id)),
      ]),
    );
  }
}

function toSnapshotItem(
  user: PresenceUserRecord,
  online: boolean,
): PresenceSnapshotItem {
  return online
    ? { status: "online", lastSeenAt: null }
    : {
        status: "offline",
        lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
      };
}
