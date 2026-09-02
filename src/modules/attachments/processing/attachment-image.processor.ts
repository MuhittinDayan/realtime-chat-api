import sharp from "sharp";

import {
  ATTACHMENT_THUMBNAIL_DIMENSION,
  MAX_ATTACHMENT_DIMENSION,
  MAX_ATTACHMENT_OUTPUT_DIMENSION,
  type AttachmentContentType,
} from "../domain/attachment.constants.ts";
import { InvalidAttachmentFileError } from "../domain/attachment.errors.ts";

export interface ProcessedAttachmentImage {
  originalBody: Uint8Array;
  thumbnailBody: Uint8Array;
  detectedContentType: AttachmentContentType;
  width: number;
  height: number;
}

export interface AttachmentImageProcessor {
  process(input: Uint8Array): Promise<ProcessedAttachmentImage>;
}

const detectedContentTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export class SharpAttachmentImageProcessor
  implements AttachmentImageProcessor {
  async process(input: Uint8Array): Promise<ProcessedAttachmentImage> {
    try {
      const source = sharp(input, {
        failOn: "warning",
        autoOrient: true,
        animated: false,
        pages: 1,
      });
      const metadata = await source.metadata();
      const detectedContentType =
        metadata.format === undefined
          ? undefined
          : detectedContentTypes[
          metadata.format as keyof typeof detectedContentTypes
          ];

      if (
        detectedContentType === undefined ||
        metadata.width === undefined ||
        metadata.height === undefined ||
        metadata.width > MAX_ATTACHMENT_DIMENSION ||
        metadata.height > MAX_ATTACHMENT_DIMENSION ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new InvalidAttachmentFileError();
      }

      const [original, thumbnail] = await Promise.all([
        source
          .clone()
          .resize({
            width: MAX_ATTACHMENT_OUTPUT_DIMENSION,
            height: MAX_ATTACHMENT_OUTPUT_DIMENSION,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 85 })
          .toBuffer({ resolveWithObject: true }),
        source
          .clone()
          .resize({
            width: ATTACHMENT_THUMBNAIL_DIMENSION,
            height: ATTACHMENT_THUMBNAIL_DIMENSION,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toBuffer(),
      ]);

      return {
        originalBody: original.data,
        thumbnailBody: thumbnail,
        detectedContentType,
        width: original.info.width,
        height: original.info.height,
      };
    } catch (error: unknown) {
      if (error instanceof InvalidAttachmentFileError) {
        throw error;
      }

      throw new InvalidAttachmentFileError(error);
    }
  }
}
