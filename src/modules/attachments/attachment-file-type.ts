import { fileTypeFromBuffer } from "file-type";

export interface AttachmentFileTypeDetector {
  detect(body: Uint8Array): Promise<string | null>;
}

export class MagicByteAttachmentFileTypeDetector
  implements AttachmentFileTypeDetector
{
  async detect(body: Uint8Array): Promise<string | null> {
    const detected = await fileTypeFromBuffer(body);

    return detected?.mime ?? null;
  }
}
