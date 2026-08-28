import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { InvalidAvatarFileError } from "./avatar.errors.js";
import { SharpAvatarImageProcessor } from "./avatar-image.processor.js";

describe("sharp avatar image processor", () => {
  it("normalizes a supported image to a metadata-free 512px WebP", async () => {
    const source = await sharp({
      create: {
        width: 800,
        height: 600,
        channels: 3,
        background: "red",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await new SharpAvatarImageProcessor().process(source);
    const metadata = await sharp(result.body).metadata();

    expect(result.detectedContentType).toBe("image/jpeg");
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);
    expect(metadata.exif).toBeUndefined();
  });

  it("rejects undecodable content", async () => {
    await expect(
      new SharpAvatarImageProcessor().process(
        new TextEncoder().encode("not an image"),
      ),
    ).rejects.toBeInstanceOf(InvalidAvatarFileError);
  });
});
