import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { InvalidAttachmentFileError } from "./attachment.errors.js";
import { SharpAttachmentImageProcessor } from "./attachment-image.processor.js";

describe("message attachment image processor", () => {
  it("creates uncropped WebP original and thumbnail outputs", async () => {
    const source = await sharp({
      create: {
        width: 1_600,
        height: 900,
        channels: 3,
        background: "blue",
      },
    })
      .jpeg()
      .withMetadata({ orientation: 1 })
      .toBuffer();
    const result = await new SharpAttachmentImageProcessor().process(source);
    const [original, thumbnail] = await Promise.all([
      sharp(result.originalBody).metadata(),
      sharp(result.thumbnailBody).metadata(),
    ]);

    expect(result.detectedContentType).toBe("image/jpeg");
    expect(original).toEqual(
      expect.objectContaining({ format: "webp", width: 1_600, height: 900 }),
    );
    expect(thumbnail).toEqual(
      expect.objectContaining({ format: "webp", width: 480, height: 270 }),
    );
    expect(original.exif).toBeUndefined();
    expect(thumbnail.exif).toBeUndefined();
  });

  it("rejects a source beyond the approved dimension boundary", async () => {
    const source = await sharp({
      create: {
        width: 8_193,
        height: 1,
        channels: 3,
        background: "red",
      },
    })
      .png()
      .toBuffer();

    await expect(
      new SharpAttachmentImageProcessor().process(source),
    ).rejects.toBeInstanceOf(InvalidAttachmentFileError);
  });

  it("bounds the normalized original without cropping its aspect ratio", async () => {
    const source = await sharp({
      create: {
        width: 5_000,
        height: 1_000,
        channels: 3,
        background: "purple",
      },
    })
      .webp()
      .toBuffer();
    const result = await new SharpAttachmentImageProcessor().process(source);
    const metadata = await sharp(result.originalBody).metadata();

    expect(metadata).toEqual(
      expect.objectContaining({ format: "webp", width: 4_096, height: 819 }),
    );
  });
});
