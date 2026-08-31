import { describe, expect, it, vi } from "vitest";

import type { MediaMessageDto } from "../../modules/messages/message.service.js";
import { SocketMessagePublisher } from "./message-publisher.js";

const message: MediaMessageDto = {
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  senderId: "33333333-3333-4333-8333-333333333333",
  clientMessageId: "44444444-4444-4444-8444-444444444444",
  kind: "MEDIA",
  body: null,
  createdAt: new Date("2030-01-01T00:00:00.000Z"),
  editedAt: null,
  deletedAt: null,
  attachments: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      originalFileName: "photo.png",
      contentType: "image/webp",
      width: 1_600,
      height: 900,
      url: "/api/v1/conversations/conversation/attachments/attachment/original",
      thumbnailUrl:
        "/api/v1/conversations/conversation/attachments/attachment/thumbnail",
    },
  ],
};

describe("socket message publisher attachment payloads", () => {
  it("includes attachments on create/update and an empty list on delete", () => {
    const emit = vi.fn();
    const namespace = {
      to: vi.fn(() => ({ emit })),
    };
    const publisher = new SocketMessagePublisher();
    publisher.bind(namespace as never);

    publisher.publishMessageCreated(message);
    publisher.publishMessageUpdated(message);
    publisher.publishMessageDeleted({
      ...message,
      body: null,
      deletedAt: new Date("2030-01-02T00:00:00.000Z"),
      attachments: [],
    });

    expect(emit.mock.calls[0]?.[0]).toBe("message:created");
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      message: { kind: "MEDIA", attachments: [{ id: message.attachments[0]?.id }] },
    });
    expect(emit.mock.calls[1]?.[0]).toBe("message:updated");
    expect(emit.mock.calls[1]?.[1]).toMatchObject({
      message: { kind: "MEDIA", attachments: [{ id: message.attachments[0]?.id }] },
    });
    expect(emit.mock.calls[2]?.[0]).toBe("message:deleted");
    expect(emit.mock.calls[2]?.[1]).toMatchObject({
      message: { kind: "MEDIA", body: null, attachments: [] },
    });
  });
});
