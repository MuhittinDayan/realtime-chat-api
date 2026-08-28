import sharp from "sharp";

import {
  AVATAR_OUTPUT_DIMENSION,
  MAX_AVATAR_DIMENSION,
} from "./avatar.constants.js";
import { InvalidAvatarFileError } from "./avatar.errors.js";

export interface ProcessedAvatarImage {
  body: Uint8Array;
  detectedContentType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

export interface AvatarImageProcessor {
  process(input: Uint8Array): Promise<ProcessedAvatarImage>;
}

const detectedContentTypes = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

export class SharpAvatarImageProcessor implements AvatarImageProcessor {
  async process(input: Uint8Array): Promise<ProcessedAvatarImage> {
    try {
      const pipeline = sharp(input, {
        failOn: "warning",
        limitInputPixels: MAX_AVATAR_DIMENSION * MAX_AVATAR_DIMENSION,
        autoOrient: true,
        animated: false,
        pages: 1,
      });
      const metadata = await pipeline.metadata();
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
        metadata.width > MAX_AVATAR_DIMENSION ||
        metadata.height > MAX_AVATAR_DIMENSION ||
        (metadata.pages ?? 1) !== 1
      ) {
        throw new InvalidAvatarFileError();
      }

      const result = await pipeline
        .resize(AVATAR_OUTPUT_DIMENSION, AVATAR_OUTPUT_DIMENSION, {
          fit: "cover",
          position: "centre",
        })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });

      return {
        body: result.data,
        detectedContentType,
        width: result.info.width,
        height: result.info.height,
      };
    } catch (error: unknown) {
      if (error instanceof InvalidAvatarFileError) {
        throw error;
      }

      throw new InvalidAvatarFileError(error);
    }
  }
}

