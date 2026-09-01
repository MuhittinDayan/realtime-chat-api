import { describe, expect, it } from "vitest";

import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
} from "./attachment.constants.js";
import { MagicByteAttachmentFileTypeDetector } from "./attachment-file-type.js";

const OOXML_CASES = [
  {
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mainPart: "word/document.xml",
    expected: ATTACHMENT_DOCX_CONTENT_TYPE,
  },
  {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mainPart: "xl/workbook.xml",
    expected: ATTACHMENT_XLSX_CONTENT_TYPE,
  },
  {
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mainPart: "ppt/presentation.xml",
    expected: ATTACHMENT_PPTX_CONTENT_TYPE,
  },
] as const;

describe("MagicByteAttachmentFileTypeDetector", () => {
  it.each(OOXML_CASES)(
    "detects $expected from OOXML package contents",
    async ({ contentType, mainPart, expected }) => {
      const detector = new MagicByteAttachmentFileTypeDetector();
      const body = createStoredZip({
        "[Content_Types].xml": contentTypesXml(contentType, mainPart),
        [mainPart]: "<root />",
      });

      await expect(detector.detect(body)).resolves.toBe(expected);
    },
  );

  it("rejects a macro-enabled OOXML main content type", async () => {
    const detector = new MagicByteAttachmentFileTypeDetector();
    const body = createStoredZip({
      "[Content_Types].xml": contentTypesXml(
        "application/vnd.ms-word.document.macroEnabled.main+xml",
        "word/document.xml",
      ),
      "word/document.xml": "<root />",
      "word/vbaProject.bin": "macro",
    });

    await expect(detector.detect(body)).resolves.toBeNull();
  });

  it("rejects a macro part even when the main content type claims DOCX", async () => {
    const detector = new MagicByteAttachmentFileTypeDetector();
    const body = createStoredZip({
      "[Content_Types].xml": contentTypesXml(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "word/document.xml",
      ),
      "word/document.xml": "<root />",
      "word/vbaProject.bin": "macro",
    });

    await expect(detector.detect(body)).resolves.toBeNull();
  });
});

function contentTypesXml(mainContentType: string, mainPart: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    `<Override PartName="/${mainPart}" ContentType="${mainContentType}"/>` +
    "</Types>"
  );
}

function createStoredZip(files: Readonly<Record<string, string>>): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const [fileName, contents] of Object.entries(files)) {
    const name = Buffer.from(fileName, "utf8");
    const data = Buffer.from(contents, "utf8");
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.byteLength, 18);
    localHeader.writeUInt32LE(data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.byteLength + name.byteLength + data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  const fileCount = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(fileCount, 8);
  end.writeUInt16LE(fileCount, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(body: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of body) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}
