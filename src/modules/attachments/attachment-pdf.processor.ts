import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfValidationFailureReason = "ENCRYPTED_PDF" | "INVALID_PDF";

export class AttachmentPdfValidationError extends Error {
  override readonly name = "AttachmentPdfValidationError";

  constructor(
    public readonly reason: PdfValidationFailureReason,
    cause?: unknown,
  ) {
    super(
      reason === "ENCRYPTED_PDF"
        ? "Encrypted PDF attachments are not supported"
        : "The PDF attachment could not be parsed",
      cause === undefined ? undefined : { cause },
    );
  }
}

export interface AttachmentPdfProcessor {
  validate(body: Uint8Array): Promise<void>;
}

export class PdfJsAttachmentPdfProcessor implements AttachmentPdfProcessor {
  async validate(body: Uint8Array): Promise<void> {
    const loadingTask = getDocument({
      data: body.slice(),
      isEvalSupported: false,
      useWorkerFetch: false,
    });

    try {
      const document = await loadingTask.promise;

      try {
        if (document.numPages < 1) {
          throw new AttachmentPdfValidationError("INVALID_PDF");
        }
      } finally {
        await document.destroy();
      }
    } catch (error: unknown) {
      if (error instanceof AttachmentPdfValidationError) {
        throw error;
      }

      const reason =
        readErrorName(error) === "PasswordException"
          ? "ENCRYPTED_PDF"
          : "INVALID_PDF";

      throw new AttachmentPdfValidationError(reason, error);
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

function readErrorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : undefined;
}
