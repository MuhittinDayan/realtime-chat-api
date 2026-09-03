import { describe, expect, it } from "vitest";

import {
  UserProfileChangeService,
  type PublicUserProfile,
  type UserProfileAudienceRepository,
  type UserProfileChangeLogger,
  type UserProfilePublisher,
} from "./user-profile-change.service.js";

const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "22222222-2222-4222-8222-222222222222";

const alice: PublicUserProfile = {
  id: ALICE_ID,
  username: "alice",
  displayName: "Alice",
  avatarUrl: null,
};

class FakeAudienceRepository implements UserProfileAudienceRepository {
  error: unknown = null;

  async findProfileAudienceUserIds(): Promise<readonly string[]> {
    if (this.error !== null) throw this.error;
    return [BOB_ID];
  }
}

class RecordingPublisher implements UserProfilePublisher {
  readonly published: Array<{
    userIds: readonly string[];
    user: PublicUserProfile;
  }> = [];
  error: unknown = null;

  publishToUsers(userIds: readonly string[], user: PublicUserProfile): void {
    if (this.error !== null) throw this.error;
    this.published.push({ userIds, user });
  }
}

class RecordingLogger implements UserProfileChangeLogger {
  readonly errors: Array<{ context: object; message: string }> = [];

  error(context: object, message: string): void {
    this.errors.push({ context, message });
  }
}

describe("user profile change service", () => {
  it("publishes the public profile to self and active conversation peers", async () => {
    const repository = new FakeAudienceRepository();
    const publisher = new RecordingPublisher();
    const service = new UserProfileChangeService(repository, publisher);

    await service.notifyProfileUpdated(alice);

    expect(publisher.published).toEqual([
      { userIds: [ALICE_ID, BOB_ID], user: alice },
    ]);
  });

  it("logs publisher failures without rejecting the completed profile update", async () => {
    const repository = new FakeAudienceRepository();
    const publisher = new RecordingPublisher();
    const changeLogger = new RecordingLogger();
    const failure = new Error("socket unavailable");
    publisher.error = failure;
    const service = new UserProfileChangeService(
      repository,
      publisher,
      changeLogger,
    );

    await expect(service.notifyProfileUpdated(alice)).resolves.toBeUndefined();
    expect(changeLogger.errors).toEqual([
      {
        context: { err: failure, userId: ALICE_ID },
        message: "User profile updated event publish failed",
      },
    ]);
  });
});
