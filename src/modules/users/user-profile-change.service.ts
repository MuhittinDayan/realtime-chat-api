import { logger } from "../../shared/logging/logger.js";

export interface PublicUserProfile {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface UserProfileAudienceRepository {
  findProfileAudienceUserIds(userId: string): Promise<readonly string[]>;
}

export interface UserProfilePublisher {
  publishToUsers(
    userIds: readonly string[],
    user: PublicUserProfile,
  ): Promise<void> | void;
}

export interface UserProfileChangeLogger {
  error(context: object, message: string): void;
}

export interface UserProfileChangeNotifier {
  notifyProfileUpdated(user: PublicUserProfile): Promise<void>;
}

export class UserProfileChangeService implements UserProfileChangeNotifier {
  constructor(
    private readonly audienceRepository: UserProfileAudienceRepository,
    private readonly publisher: UserProfilePublisher,
    private readonly changeLogger: UserProfileChangeLogger = logger,
  ) {}

  async notifyProfileUpdated(user: PublicUserProfile): Promise<void> {
    try {
      const audienceUserIds =
        await this.audienceRepository.findProfileAudienceUserIds(user.id);

      await this.publisher.publishToUsers(
        [user.id, ...audienceUserIds],
        toPublicUserProfile(user),
      );
    } catch (error: unknown) {
      this.changeLogger.error(
        { err: error, userId: user.id },
        "User profile updated event publish failed",
      );
    }
  }
}

export function toPublicUserProfile(
  user: PublicUserProfile,
): PublicUserProfile {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}
