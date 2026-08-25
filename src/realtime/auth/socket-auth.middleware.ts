import type { Socket } from "socket.io";

import type { AccessAuthenticator } from "../../modules/auth/auth.middleware.js";
import type {
  ChatClientToServerEvents,
  ChatInterServerEvents,
  ChatServerToClientEvents,
  ChatSocketData,
} from "../server/chat-events.js";

type ChatSocket = Socket<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  ChatInterServerEvents,
  ChatSocketData
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class SocketAuthenticationError extends Error {
  readonly data = { code: "INVALID_TOKEN" } as const;

  constructor() {
    super("Authentication failed");
    this.name = "SocketAuthenticationError";
  }
}

export function createSocketAuthenticationMiddleware(
  authenticator: AccessAuthenticator,
): (socket: ChatSocket, next: (error?: Error) => void) => Promise<void> {
  return async (socket, next): Promise<void> => {
    const authentication: unknown = socket.handshake.auth;
    const token = isRecord(authentication) ? authentication.token : null;

    if (typeof token !== "string" || token.length === 0) {
      next(new SocketAuthenticationError());
      return;
    }

    try {
      const auth = await authenticator.authenticateAccessToken(token);
      socket.data.userId = auth.userId;
      socket.data.sessionId = auth.sessionId;
      next();
    } catch {
      next(new SocketAuthenticationError());
    }
  };
}
