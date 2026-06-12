import { describe, expect, it } from "vitest";
import {
  MAX_NATIVE_DOCUMENT_SOURCE_BYTES,
  MAX_TEXT_SOURCE_BYTES,
  describeSourceFile,
  describeTextSourceFile,
  formatFileSize,
  looksLikeReadableText
} from "./sourceUpload";

describe("source upload safety", () => {
  it("allows supported text-like source files", () => {
    expect(
      describeTextSourceFile({
        name: "renewal-note.md",
        size: 420,
        type: ""
      })
    ).toEqual({ supported: true });
    expect(
      describeTextSourceFile({
        name: "benefits.json",
        size: 420,
        type: "application/json"
      })
    ).toEqual({ supported: true });
    expect(
      describeTextSourceFile({
        name: "capture.unknown",
        size: 420,
        type: "text/plain"
      })
    ).toEqual({ supported: true });
  });

  it("keeps the legacy text-only helper conservative", () => {
    expect(
      describeTextSourceFile({
        name: "insurance-policy.pdf",
        size: 420,
        type: "application/pdf"
      })
    ).toEqual({ supported: false, reason: "unsupported_type" });
    expect(
      describeTextSourceFile({
        name: "scan.png",
        size: 420,
        type: "image/png"
      })
    ).toEqual({ supported: false, reason: "unsupported_type" });
  });

  it("allows native PDF and Office extraction in the Desktop app", () => {
    expect(
      describeSourceFile(
        {
          name: "insurance-policy.pdf",
          size: 420,
          type: "application/pdf"
        },
        true
      )
    ).toEqual({ supported: true, extraction: "native_document" });
    expect(
      describeSourceFile(
        {
          name: "benefits.docx",
          size: 420,
          type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        },
        true
      )
    ).toEqual({ supported: true, extraction: "native_document" });
  });

  it("requires the native extractor for binary documents", () => {
    expect(
      describeSourceFile(
        {
          name: "insurance-policy.pdf",
          size: 420,
          type: "application/pdf"
        },
        false
      )
    ).toEqual({ supported: false, reason: "native_required" });
  });

  it("requires OCR configuration for image documents and blocks legacy Office documents", () => {
    expect(
      describeSourceFile(
        {
          name: "scan.png",
          size: 420,
          type: "image/png"
        },
        true
      )
    ).toEqual({ supported: false, reason: "ocr_required" });
    expect(
      describeSourceFile(
        {
          name: "scan.png",
          size: 420,
          type: "image/png"
        },
        true,
        true
      )
    ).toEqual({ supported: true, extraction: "native_ocr" });
    expect(
      describeSourceFile(
        {
          name: "old-benefits.doc",
          size: 420,
          type: "application/msword"
        },
        true
      )
    ).toEqual({ supported: false, reason: "legacy_office" });
    expect(
      describeSourceFile(
        {
          name: "old-benefits.doc",
          size: 420,
          type: "application/msword"
        },
        true,
        false,
        true
      )
    ).toEqual({ supported: true, extraction: "native_document" });
  });

  it("rejects oversized text sources for the current local extractor", () => {
    expect(
      describeTextSourceFile({
        name: "huge.csv",
        size: MAX_TEXT_SOURCE_BYTES + 1,
        type: "text/csv"
      })
    ).toEqual({ supported: false, reason: "too_large" });
  });

  it("rejects oversized native documents before extraction", () => {
    expect(
      describeSourceFile(
        {
          name: "huge-policy.pdf",
          size: MAX_NATIVE_DOCUMENT_SOURCE_BYTES + 1,
          type: "application/pdf"
        },
        true
      )
    ).toEqual({ supported: false, reason: "too_large" });
  });

  it("detects unreadable binary content even when the extension looks textual", () => {
    expect(looksLikeReadableText("Insurance policy renews on 2027-08-31.")).toBe(true);
    expect(looksLikeReadableText("%PDF-1.7\n1 0 obj")).toBe(false);
    expect(looksLikeReadableText("PK\u0003\u0004word/document.xml")).toBe(false);
    expect(looksLikeReadableText("\u0089PNG\r\n")).toBe(false);
    expect(looksLikeReadableText("")).toBe(false);
  });

  it("formats file sizes for user-facing upload messages", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2 MB");
  });
});
