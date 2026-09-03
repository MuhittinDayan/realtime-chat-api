import type { Namespace } from "socket.io";

import type {
  PublicUserProfile,
  UserProfilePublisher,
} from "../../modules/users/user-profile-change.service.js";
import { userRoom } from "../rooms/room-names.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
} from "../server/chat-events.js";

type ChatNamespace = Namespace<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

export class SocketUserProfilePublisher implements UserProfilePublisher {
  private namespace: ChatNamespace | null = null;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishToUsers(
    userIds: readonly string[],
    user: PublicUserProfile,
  ): void {
    const rooms = [...new Set(userIds)].map(userRoom);

    if (this.namespace === null || rooms.length === 0) {
      return;
    }

    this.namespace.to(rooms).emit("user:updated", { user });
  }
}

export const socketUserProfilePublisher = new SocketUserProfilePublisher();
