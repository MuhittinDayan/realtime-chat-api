import type { Namespace } from "socket.io";

import type { SessionRevocationPublisher } from "../../modules/auth/application/auth.contracts.js";
import { sessionRoom } from "../rooms/room-names.js";
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

export class SocketSessionRevocationPublisher
  implements SessionRevocationPublisher
{
  private namespace?: ChatNamespace;

  bind(namespace: ChatNamespace): void {
    this.namespace = namespace;
  }

  publishRevoked(sessionIds: readonly string[]): void {
    const namespace = this.namespace;

    if (namespace === undefined) {
      return;
    }

    for (const sessionId of new Set(sessionIds)) {
      const target = namespace.in(sessionRoom(sessionId));
      target.emit("auth:revoked");
      target.disconnectSockets(true);
    }
  }
}

export const socketSessionRevocationPublisher =
  new SocketSessionRevocationPublisher();
