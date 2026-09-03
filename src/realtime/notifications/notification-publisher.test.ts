import { describe, expect, it, vi } from "vitest";

import { SocketNotificationPublisher } from "./notification-publisher.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const NOTIFICATION_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2030-01-01T00:00:00.000Z");

describe("socket notification publisher", () => {
  it("targets the recipient user room with minimal payloads", () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const publisher = new SocketNotificationPublisher();
    publisher.bind({ to } as never);

    publisher.publishCreated({
      id: NOTIFICATION_ID,
      type: "MESSAGE_CREATED",
      recipientUserId: USER_ID,
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      createdAt: NOW,
    });
    publisher.publishRead({
      id: NOTIFICATION_ID,
      recipientUserId: USER_ID,
      readAt: NOW,
    });
    publisher.publishConversationRead({
      recipientUserId: USER_ID,
      conversationId: CONVERSATION_ID,
      markedCount: 3,
    });

    expect(to).toHaveBeenCalledTimes(3);
    expect(to).toHaveBeenNthCalledWith(1, `user:${USER_ID}`);
    expect(to).toHaveBeenNthCalledWith(2, `user:${USER_ID}`);
    expect(to).toHaveBeenNthCalledWith(3, `user:${USER_ID}`);
    expect(emit.mock.calls).toEqual([
      [
        "notification:created",
        {
          id: NOTIFICATION_ID,
          type: "MESSAGE_CREATED",
          conversationId: CONVERSATION_ID,
          messageId: MESSAGE_ID,
          createdAt: NOW.toISOString(),
        },
      ],
      [
        "notification:read",
        { id: NOTIFICATION_ID, readAt: NOW.toISOString() },
      ],
      [
        "notifications:read",
        { conversationId: CONVERSATION_ID, markedCount: 3 },
      ],
    ]);
  });
});
