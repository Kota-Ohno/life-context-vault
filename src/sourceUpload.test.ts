import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_SOURCE_BYTES,
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

  it("rejects unsupported binary document families before Source creation", () => {
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

  it("rejects oversized text sources for the current local extractor", () => {
    expect(
      describeTextSourceFile({
        name: "huge.csv",
        size: MAX_TEXT_SOURCE_BYTES + 1,
        type: "text/csv"
      })
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
