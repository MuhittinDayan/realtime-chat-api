import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { provisionStorage } from "./provision-storage.js";

describe("provisionStorage", () => {
  it("creates missing buckets and makes only processed avatars public", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      })
      .mockResolvedValue({});
    const client = { send } as unknown as S3Client;

    await provisionStorage(client, {
      avatarBucket: "chat-avatars",
      attachmentBucket: "chat-attachments",
      frontendOrigin: "http://localhost:3000",
    });

    const commands = send.mock.calls.map(([command]) => command);
    expect(commands.filter((command) => command instanceof HeadBucketCommand)).toHaveLength(2);
    expect(commands.filter((command) => command instanceof CreateBucketCommand)).toHaveLength(1);
    expect(commands.filter((command) => command instanceof PutBucketCorsCommand)).toHaveLength(2);

    const policyCommand = commands.find(
      (command) => command instanceof PutBucketPolicyCommand,
    ) as PutBucketPolicyCommand;
    const policy = JSON.parse(policyCommand.input.Policy ?? "{}") as {
      Statement: Array<{ Resource: string[] }>;
    };
    expect(policyCommand.input.Bucket).toBe("chat-avatars");
    expect(policy.Statement[0]?.Resource).toEqual([
      "arn:aws:s3:::chat-avatars/public/*",
    ]);
    expect(policyCommand.input.Policy).not.toContain("incoming/*");
    expect(policyCommand.input.Policy).not.toContain("chat-attachments");
  });

  it("does not hide authorization or provider errors", async () => {
    const accessDenied = Object.assign(new Error("denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    const client = {
      send: vi.fn().mockRejectedValue(accessDenied),
    } as unknown as S3Client;

    await expect(
      provisionStorage(client, {
        avatarBucket: "chat-avatars",
        attachmentBucket: "chat-attachments",
        frontendOrigin: "http://localhost:3000",
      }),
    ).rejects.toBe(accessDenied);
  });

  it("requires physically separate avatar and attachment buckets", async () => {
    const client = { send: vi.fn() } as unknown as S3Client;

    await expect(
      provisionStorage(client, {
        avatarBucket: "chat-media",
        attachmentBucket: "chat-media",
        frontendOrigin: "http://localhost:3000",
      }),
    ).rejects.toThrow("separate buckets");
  });
});
