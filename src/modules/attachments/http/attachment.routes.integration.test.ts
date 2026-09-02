import { Router, type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app.ts";
import {
  createAuthenticationMiddleware,
  type AccessAuthenticator,
} from "../../auth/http/auth.middleware.js";
import {
  AttachmentController,
  type AttachmentHttpService,
} from "./attachment.controller.ts";
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_OFFICE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
} from "../domain/attachment.constants.ts";
import { createAttachmentRouter } from "./attachment.routes.ts";
import type { CreateAttachmentUploadInput } from "./attachment.schema.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2030-01-01T00:00:00.000Z");

class FakeAuthenticator implements AccessAuthenticator {
  async authenticateAccessToken() {
    return { userId: USER_ID, sessionId: "session", jwtId: "jwt" };
  }
}

class FakeAttachmentService implements AttachmentHttpService {
  createInput: CreateAttachmentUploadInput | null = null;
  completed = false;
  accessedVariant: "original" | "thumbnail" | null = null;

  async createUpload(
    _ownerId: string,
    _conversationId: string,
    input: CreateAttachmentUploadInput,
  ) {
    this.createInput = input;
    return {
      attachmentId: ATTACHMENT_ID,
      upload: {
        url: "http://storage/upload",
        method: "PUT" as const,
        headers: { "Content-Type": input.contentType },
        expiresAt: NOW,
      },
    };
  }

  async completeUpload() {
    this.completed = true;
    return {
      id: ATTACHMENT_ID,
      kind: "IMAGE" as const,
      originalFileName: "photo.png",
      contentType: "image/webp" as const,
      width: 1_600,
      height: 900,
      url: `/api/v1/conversations/${CONVERSATION_ID}/attachments/${ATTACHMENT_ID}/original`,
      thumbnailUrl: `/api/v1/conversations/${CONVERSATION_ID}/attachments/${ATTACHMENT_ID}/thumbnail`,
    };
  }

  async createAccess(
    _userId: string,
    _conversationId: string,
    _attachmentId: string,
    variant: "original" | "thumbnail",
  ) {
    this.accessedVariant = variant;
    return {
      url: "http://storage/download",
      method: "GET" as const,
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
  }
}

const noRateLimit: RequestHandler = (_request, _response, next) => next();

function createTestApp(service: FakeAttachmentService) {
  const apiRouter = Router();
  apiRouter.use(createAuthenticationMiddleware(new FakeAuthenticator()));
  apiRouter.use(
    "/conversations/:conversationId/attachments",
    createAttachmentRouter(
      new AttachmentController(service),
      noRateLimit,
    ),
  );

  return createApp({ apiRouter });
}

describe("message attachment HTTP routes", () => {
  it("creates and completes an image upload", async () => {
    const service = new FakeAttachmentService();
    const app = createTestApp(service);
    const collection =
      `/api/v1/conversations/${CONVERSATION_ID}/attachments`;

    await request(app)
      .post(`${collection}/uploads`)
      .set("Authorization", "Bearer token")
      .send({
        contentType: "image/png",
        contentLength: 4,
        originalFileName: " photo.png ",
      })
      .expect(201);
    const completed = await request(app)
      .post(`${collection}/uploads/${ATTACHMENT_ID}/complete`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(service.createInput).toEqual({
      contentType: "image/png",
      contentLength: 4,
      originalFileName: "photo.png",
    });
    expect(service.completed).toBe(true);
    expect(completed.body.attachment.thumbnailUrl).toContain("/thumbnail");
  });

  it("rejects a source above 10 MiB before service access", async () => {
    const service = new FakeAttachmentService();
    const response = await request(createTestApp(service))
      .post(
        `/api/v1/conversations/${CONVERSATION_ID}/attachments/uploads`,
      )
      .set("Authorization", "Bearer token")
      .send({
        contentType: "image/png",
        contentLength: MAX_IMAGE_ATTACHMENT_BYTES + 1,
        originalFileName: "photo.png",
      })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(service.createInput).toBeNull();
  });

  it("accepts a PDF upload intent up to 25 MiB", async () => {
    const service = new FakeAttachmentService();

    await request(createTestApp(service))
      .post(
        `/api/v1/conversations/${CONVERSATION_ID}/attachments/uploads`,
      )
      .set("Authorization", "Bearer token")
      .send({
        contentType: "application/pdf",
        contentLength: MAX_PDF_ATTACHMENT_BYTES,
        originalFileName: "report.pdf",
      })
      .expect(201);

    expect(service.createInput?.contentType).toBe("application/pdf");
  });

  it("accepts an Office upload intent up to 20 MiB", async () => {
    const service = new FakeAttachmentService();

    await request(createTestApp(service))
      .post(
        `/api/v1/conversations/${CONVERSATION_ID}/attachments/uploads`,
      )
      .set("Authorization", "Bearer token")
      .send({
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentLength: MAX_OFFICE_ATTACHMENT_BYTES,
        originalFileName: "report.docx",
      })
      .expect(201);

    expect(service.createInput?.contentLength).toBe(
      MAX_OFFICE_ATTACHMENT_BYTES,
    );
  });

  it("rejects an Office upload intent above 20 MiB", async () => {
    const service = new FakeAttachmentService();

    await request(createTestApp(service))
      .post(
        `/api/v1/conversations/${CONVERSATION_ID}/attachments/uploads`,
      )
      .set("Authorization", "Bearer token")
      .send({
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        contentLength: MAX_OFFICE_ATTACHMENT_BYTES + 1,
        originalFileName: "report.xlsx",
      })
      .expect(400);

    expect(service.createInput).toBeNull();
  });

  it("redirects an authorized access request to a fresh presigned GET", async () => {
    const service = new FakeAttachmentService();
    const response = await request(createTestApp(service))
      .get(
        `/api/v1/conversations/${CONVERSATION_ID}` +
        `/attachments/${ATTACHMENT_ID}/thumbnail`,
      )
      .set("Authorization", "Bearer token")
      .expect(307);

    expect(service.accessedVariant).toBe("thumbnail");
    expect(response.headers.location).toBe("http://storage/download");
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
