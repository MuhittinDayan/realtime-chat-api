import { describe, expect, it } from "vitest";

import type { Clock } from "../../shared/time/clock.js";
import { ConnectionRegistry } from "./connection-registry.js";
import type {
  PresenceRepository,
  PresenceUserRecord,
} from "./presence.repository.js";
import {
  PresenceService,
  type PresencePublisher,
  type PresenceUpdatedEvent,
} from "./presence.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";
const CAROL_ID = "33333333-3333-4333-8333-333333333333";
const UNRELATED_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");

class FakePresenceRepository implements PresenceRepository {
  readonly peerIds = [BOB_ID];
  readonly users: PresenceUserRecord[] = [
    { id: BOB_ID, lastSeenAt: NOW },
    { id: CAROL_ID, lastSeenAt: NOW },
  ];
  updateCount = 0;
  requestedUserIds: readonly string[] = [];

  async findDirectPeerIds(): Promise<readonly string[]> {
    return this.peerIds;
  }

  async findAuthorizedUsers(
    _requesterId: string,
    requestedUserIds: readonly string[],
  ): Promise<readonly PresenceUserRecord[]> {
    this.requestedUserIds = requestedUserIds;
    return this.users.filter((user) => requestedUserIds.includes(user.id));
  }

  async updateLastSeen(
    _userId: string,
    lastSeenAt: Date,
  ): Promise<Date> {
    this.updateCount += 1;
    return lastSeenAt;
  }
}

class RecordingPresencePublisher implements PresencePublisher {
  readonly published: {
    userIds: readonly string[];
    event: PresenceUpdatedEvent;
  }[] = [];

  publishToUsers(
    userIds: readonly string[],
    event: PresenceUpdatedEvent,
  ): void {
    this.published.push({ userIds, event });
  }
}

const fixedClock: Clock = { now: () => NOW };

function createHarness() {
  const registry = new ConnectionRegistry();
  const repository = new FakePresenceRepository();
  const publisher = new RecordingPresencePublisher();
  const service = new PresenceService(
    registry,
    repository,
    publisher,
    fixedClock,
  );
  return { service, registry, repository, publisher };
}

describe("presence lifecycle service", () => {
  it("publishes online only for the first socket", async () => {
    const { service, publisher } = createHarness();

    await service.handleConnected(ALICE_ID, "socket-1");
    await service.handleConnected(ALICE_ID, "socket-2");

    expect(publisher.published).toEqual([
      {
        userIds: [BOB_ID],
        event: {
          userId: ALICE_ID,
          status: "online",
          lastSeenAt: null,
        },
      },
    ]);
  });

  it("stays online until the final socket disconnects", async () => {
    const { service, repository, publisher } = createHarness();
    await service.handleConnected(ALICE_ID, "socket-1");
    await service.handleConnected(ALICE_ID, "socket-2");

    await service.handleDisconnected(ALICE_ID, "socket-1");
    expect(repository.updateCount).toBe(0);
    expect(publisher.published).toHaveLength(1);

    await service.handleDisconnected(ALICE_ID, "socket-2");
    expect(repository.updateCount).toBe(1);
    expect(publisher.published[1]).toEqual({
      userIds: [BOB_ID],
      event: {
        userId: ALICE_ID,
        status: "offline",
        lastSeenAt: NOW,
      },
    });
  });
});

describe("presence snapshot service", () => {
  it("deduplicates ids, combines memory online state and omits unauthorized users", async () => {
    const { service, registry, repository } = createHarness();
    registry.add(BOB_ID, "bob-socket");

    const snapshot = await service.getSnapshot(ALICE_ID, [
      BOB_ID,
      BOB_ID,
      CAROL_ID,
      UNRELATED_ID,
    ]);

    expect(repository.requestedUserIds).toEqual([
      BOB_ID,
      CAROL_ID,
      UNRELATED_ID,
    ]);
    expect(snapshot).toEqual({
      [BOB_ID]: { status: "online", lastSeenAt: null },
      [CAROL_ID]: {
        status: "offline",
        lastSeenAt: NOW.toISOString(),
      },
    });
    expect(snapshot).not.toHaveProperty(UNRELATED_ID);
  });
});
