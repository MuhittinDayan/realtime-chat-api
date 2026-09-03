import { describe, expect, it, vi } from "vitest";

import { SocketUserProfilePublisher } from "./user-profile-publisher.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";

describe("SocketUserProfilePublisher", () => {
  it("deduplicates user rooms and publishes the public profile payload", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const publisher = new SocketUserProfilePublisher();
    publisher.bind({ to } as never);

    publisher.publishToUsers([ALICE_ID, BOB_ID, BOB_ID], {
      id: ALICE_ID,
      username: "new-alice",
      displayName: "New Alice",
      avatarUrl: "https://cdn.test/alice.webp",
    });

    expect(to).toHaveBeenCalledWith([
      `user:${ALICE_ID}`,
      `user:${BOB_ID}`,
    ]);
    expect(emit).toHaveBeenCalledWith("user:updated", {
      user: {
        id: ALICE_ID,
        username: "new-alice",
        displayName: "New Alice",
        avatarUrl: "https://cdn.test/alice.webp",
      },
    });
  });

  it("does nothing before namespace binding or for an empty audience", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const publisher = new SocketUserProfilePublisher();

    publisher.publishToUsers([], {
      id: ALICE_ID,
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
    });
    publisher.bind({ to } as never);
    publisher.publishToUsers([], {
      id: ALICE_ID,
      username: "alice",
      displayName: "Alice",
      avatarUrl: null,
    });

    expect(to).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
