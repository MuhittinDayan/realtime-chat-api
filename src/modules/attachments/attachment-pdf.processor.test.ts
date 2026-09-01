import { describe, expect, it } from "vitest";

import {
  AttachmentPdfValidationError,
  PdfJsAttachmentPdfProcessor,
} from "./attachment-pdf.processor.js";

describe("PdfJsAttachmentPdfProcessor", () => {
  const processor = new PdfJsAttachmentPdfProcessor();

  it("accepts a parseable PDF with bytes after the EOF marker", async () => {
    const pdf = buildMinimalPdf(false, "\ntrailing transport bytes");

    await expect(processor.validate(pdf)).resolves.toBeUndefined();
  });

  it("classifies an encrypted PDF as permanently invalid", async () => {
    await expect(processor.validate(buildMinimalPdf(true))).rejects.toMatchObject({
      name: "AttachmentPdfValidationError",
      reason: "ENCRYPTED_PDF",
    } satisfies Partial<AttachmentPdfValidationError>);
  });

  it("rejects a fake PDF header that cannot be parsed", async () => {
    const fake = new TextEncoder().encode(
      "%PDF-1.7\nthis is not a PDF object graph\n%%EOF\n",
    );

    await expect(processor.validate(fake)).rejects.toMatchObject({
      name: "AttachmentPdfValidationError",
      reason: "INVALID_PDF",
    } satisfies Partial<AttachmentPdfValidationError>);
  });
});

function buildMinimalPdf(encrypted: boolean, suffix = ""): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
    ...(encrypted
      ? [
          "<< /Filter /Standard /V 1 /R 2 " +
            "/O <0000000000000000000000000000000000000000000000000000000000000000> " +
            "/U <0000000000000000000000000000000000000000000000000000000000000000> " +
            "/P -4 >>",
        ]
      : []),
  ];
  const offsets = [0];
  let source = "%PDF-1.4\n";

  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${String(index + 1)} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(source);
  source += `xref\n0 ${String(objects.length + 1)}\n`;
  source += "0000000000 65535 f \n";

  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }

  const encryptionTrailer = encrypted
    ? " /Encrypt 5 0 R " +
      "/ID [<00112233445566778899AABBCCDDEEFF>" +
      "<00112233445566778899AABBCCDDEEFF>]"
    : "";
  source +=
    `trailer\n<< /Size ${String(objects.length + 1)} ` +
    `/Root 1 0 R${encryptionTrailer} >>\n` +
    `startxref\n${String(xrefOffset)}\n%%EOF\n${suffix}`;

  return new TextEncoder().encode(source);
}
