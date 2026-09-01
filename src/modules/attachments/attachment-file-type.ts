import { inflateRawSync } from "node:zlib";

import { fileTypeFromBuffer } from "file-type";

import {
  ATTACHMENT_DOCX_CONTENT_TYPE,
  ATTACHMENT_PPTX_CONTENT_TYPE,
  ATTACHMENT_XLSX_CONTENT_TYPE,
  type AttachmentContentType,
} from "./attachment.constants.js";

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;
const MAX_OOXML_ENTRY_COUNT = 1_000;
const MAX_CONTENT_TYPES_BYTES = 1_024 * 1_024;
const CONTENT_TYPES_FILE_NAME = "[Content_Types].xml";

interface ZipEntry {
  fileName: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface AttachmentFileTypeDetector {
  detect(body: Uint8Array): Promise<string | null>;
}

export class MagicByteAttachmentFileTypeDetector
  implements AttachmentFileTypeDetector
{
  async detect(body: Uint8Array): Promise<string | null> {
    const detected = await fileTypeFromBuffer(body);

    if (!hasZipSignature(body)) {
      return detected?.mime ?? null;
    }

    return detectOpenXmlContentType(body);
  }
}

function hasZipSignature(body: Uint8Array): boolean {
  return (
    body.byteLength >= 4 &&
    new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
      0,
      true,
    ) === ZIP_LOCAL_FILE_HEADER_SIGNATURE
  );
}

function detectOpenXmlContentType(
  body: Uint8Array,
): AttachmentContentType | null {
  try {
    const entries = readZipEntries(body);

    if (
      entries.some((entry) =>
        entry.fileName.toLowerCase().endsWith("/vbaproject.bin"),
      )
    ) {
      return null;
    }

    const contentTypesEntry = entries.find(
      (entry) => entry.fileName === CONTENT_TYPES_FILE_NAME,
    );

    if (contentTypesEntry === undefined) {
      return null;
    }

    const contentTypesXml = new TextDecoder("utf-8", { fatal: true }).decode(
      readZipEntry(body, contentTypesEntry),
    );

    if (/macroenabled|vnd\.ms-office\.vbaproject/iu.test(contentTypesXml)) {
      return null;
    }

    const detectedTypes: AttachmentContentType[] = [];

    if (
      hasMainPartContentType(
        contentTypesXml,
        "/word/document.xml",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      ) &&
      hasZipEntry(entries, "word/document.xml")
    ) {
      detectedTypes.push(ATTACHMENT_DOCX_CONTENT_TYPE);
    }

    if (
      hasMainPartContentType(
        contentTypesXml,
        "/xl/workbook.xml",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      ) &&
      hasZipEntry(entries, "xl/workbook.xml")
    ) {
      detectedTypes.push(ATTACHMENT_XLSX_CONTENT_TYPE);
    }

    if (
      hasMainPartContentType(
        contentTypesXml,
        "/ppt/presentation.xml",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
      ) &&
      hasZipEntry(entries, "ppt/presentation.xml")
    ) {
      detectedTypes.push(ATTACHMENT_PPTX_CONTENT_TYPE);
    }

    return detectedTypes.length === 1 ? (detectedTypes[0] ?? null) : null;
  } catch {
    return null;
  }
}

function hasMainPartContentType(
  contentTypesXml: string,
  expectedPartName: string,
  expectedContentType: string,
): boolean {
  for (const match of contentTypesXml.matchAll(/<Override\b[^>]*>/giu)) {
    const tag = match[0];
    const partName = /\bPartName\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    const contentType = /\bContentType\s*=\s*["']([^"']+)["']/iu.exec(
      tag,
    )?.[1];

    if (
      partName === expectedPartName &&
      contentType?.toLowerCase() === expectedContentType
    ) {
      return true;
    }
  }

  return false;
}

function readZipEntries(body: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(endOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const totalEntries = view.getUint16(endOffset + 10, true);
  const centralDirectorySize = view.getUint32(endOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries < 1 ||
    totalEntries > MAX_OOXML_ENTRY_COUNT ||
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectoryOffset + centralDirectorySize > body.byteLength
  ) {
    throw new Error("Unsupported ZIP central directory");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  for (let index = 0; index < totalEntries; index += 1) {
    if (
      offset + 46 > centralDirectoryEnd ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const fileNameLength = view.getUint16(offset + 28, true);
    const extraFieldLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const entryEnd =
      offset + 46 + fileNameLength + extraFieldLength + commentLength;

    if (entryEnd > centralDirectoryEnd) {
      throw new Error("Truncated ZIP central directory entry");
    }

    entries.push({
      fileName: decoder.decode(
        body.subarray(offset + 46, offset + 46 + fileNameLength),
      ),
      flags: view.getUint16(offset + 8, true),
      compressionMethod: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset = entryEnd;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error("Invalid ZIP central directory size");
  }

  return entries;
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstPossibleOffset = Math.max(
    0,
    view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES - ZIP_MAX_COMMENT_BYTES,
  );

  for (
    let offset = view.byteLength - ZIP_END_OF_CENTRAL_DIRECTORY_BYTES;
    offset >= firstPossibleOffset;
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) ===
        ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      offset +
        ZIP_END_OF_CENTRAL_DIRECTORY_BYTES +
        view.getUint16(offset + 20, true) ===
        view.byteLength
    ) {
      return offset;
    }
  }

  throw new Error("ZIP end of central directory not found");
}

function readZipEntry(body: Uint8Array, entry: ZipEntry): Uint8Array {
  if (
    (entry.flags & 0x1) !== 0 ||
    entry.compressedSize > MAX_CONTENT_TYPES_BYTES ||
    entry.uncompressedSize > MAX_CONTENT_TYPES_BYTES ||
    entry.localHeaderOffset + 30 > body.byteLength
  ) {
    throw new Error("Unsupported ZIP entry");
  }

  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);

  if (
    view.getUint32(entry.localHeaderOffset, true) !==
      ZIP_LOCAL_FILE_HEADER_SIGNATURE ||
    (view.getUint16(entry.localHeaderOffset + 6, true) & 0x1) !== 0 ||
    view.getUint16(entry.localHeaderOffset + 8, true) !==
      entry.compressionMethod
  ) {
    throw new Error("Invalid ZIP local file header");
  }

  const fileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraFieldLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataOffset =
    entry.localHeaderOffset + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataOffset + entry.compressedSize;

  if (dataEnd > body.byteLength) {
    throw new Error("Truncated ZIP entry");
  }

  const compressed = body.subarray(dataOffset, dataEnd);

  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new Error("Invalid stored ZIP entry size");
    }

    return compressed;
  }

  if (entry.compressionMethod === 8) {
    const decompressed = inflateRawSync(compressed, {
      maxOutputLength: MAX_CONTENT_TYPES_BYTES,
    });

    if (decompressed.byteLength !== entry.uncompressedSize) {
      throw new Error("Invalid deflated ZIP entry size");
    }

    return decompressed;
  }

  throw new Error("Unsupported ZIP compression method");
}

function hasZipEntry(entries: readonly ZipEntry[], fileName: string): boolean {
  return entries.some((entry) => entry.fileName === fileName);
}
