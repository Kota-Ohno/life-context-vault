export const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_NATIVE_DOCUMENT_SOURCE_BYTES = 12 * 1024 * 1024;

export const SUPPORTED_TEXT_SOURCE_EXTENSIONS = [
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".log"
] as const;


export const SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS = [
  ".pdf",
  ".docx",
  ".pptx",
  ".xlsx",
  ".odt",
  ".ods",
  ".odp"
] as const;

export const OCR_DOCUMENT_EXTENSIONS = [
  ".gif",
  ".png",
  ".jpg",
  ".jpeg",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".webp"
] as const;

export const LEGACY_OFFICE_EXTENSIONS = [".doc", ".xls", ".ppt"] as const;

export const SUPPORTED_SOURCE_ACCEPT = [
  ...SUPPORTED_TEXT_SOURCE_EXTENSIONS,
  ...SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS
].join(",");
export const SUPPORTED_SOURCE_LABEL = "TXT, PDF, DOCX, PPTX, XLSX, ODT/ODS/ODP";
export const SUPPORTED_SOURCE_ACCEPT_WITH_OCR = [
  ...SUPPORTED_TEXT_SOURCE_EXTENSIONS,
  ...SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS,
  ...OCR_DOCUMENT_EXTENSIONS
].join(",");
export const SUPPORTED_SOURCE_LABEL_WITH_OCR = "TXT, PDF, Office, OpenDocument, Images";

const supportedMimeTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/x-log",
  "text/yaml"
]);

export type TextSourceFileDecision =
  | { supported: true }
  | { supported: false; reason: "too_large" | "unsupported_type" };

export type SourceFileDecision =
  | { supported: true; extraction: "browser_text" | "native_document" | "native_ocr" }
  | {
      supported: false;
      reason: "too_large" | "native_required" | "ocr_required" | "legacy_office" | "unsupported_type";
    };

export function describeTextSourceFile(
  file: Pick<File, "name" | "size" | "type">
): TextSourceFileDecision {
  if (file.size > MAX_TEXT_SOURCE_BYTES) {
    return { supported: false, reason: "too_large" };
  }

  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  if (
    mimeType.startsWith("text/") ||
    supportedMimeTypes.has(mimeType) ||
    SUPPORTED_TEXT_SOURCE_EXTENSIONS.includes(extension as (typeof SUPPORTED_TEXT_SOURCE_EXTENSIONS)[number])
  ) {
    return { supported: true };
  }

  return { supported: false, reason: "unsupported_type" };
}

export function describeSourceFile(
  file: Pick<File, "name" | "size" | "type">,
  nativeExtractionAvailable: boolean,
  ocrExtractionAvailable = false,
  legacyOfficeConversionAvailable = false
): SourceFileDecision {
  const extension = fileExtension(file.name);
  const mimeType = file.type.toLowerCase();
  const isTextLike =
    mimeType.startsWith("text/") ||
    supportedMimeTypes.has(mimeType) ||
    SUPPORTED_TEXT_SOURCE_EXTENSIONS.includes(extension as (typeof SUPPORTED_TEXT_SOURCE_EXTENSIONS)[number]);
  if (isTextLike) {
    if (file.size > MAX_TEXT_SOURCE_BYTES) return { supported: false, reason: "too_large" };
    return { supported: true, extraction: "browser_text" };
  }

  const isNativeDocument =
    supportedNativeMimeTypes.has(mimeType) ||
    SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS.includes(
      extension as (typeof SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS)[number]
    );
  if (isNativeDocument) {
    if (file.size > MAX_NATIVE_DOCUMENT_SOURCE_BYTES) return { supported: false, reason: "too_large" };
    if (!nativeExtractionAvailable) return { supported: false, reason: "native_required" };
    return { supported: true, extraction: "native_document" };
  }

  if (
    mimeType.startsWith("image/") ||
    OCR_DOCUMENT_EXTENSIONS.includes(extension as (typeof OCR_DOCUMENT_EXTENSIONS)[number])
  ) {
    if (file.size > MAX_NATIVE_DOCUMENT_SOURCE_BYTES) return { supported: false, reason: "too_large" };
    if (nativeExtractionAvailable && ocrExtractionAvailable) return { supported: true, extraction: "native_ocr" };
    return { supported: false, reason: "ocr_required" };
  }
  if (
    legacyOfficeMimeTypes.has(mimeType) ||
    LEGACY_OFFICE_EXTENSIONS.includes(extension as (typeof LEGACY_OFFICE_EXTENSIONS)[number])
  ) {
    if (file.size > MAX_NATIVE_DOCUMENT_SOURCE_BYTES) return { supported: false, reason: "too_large" };
    if (nativeExtractionAvailable && legacyOfficeConversionAvailable) {
      return { supported: true, extraction: "native_document" };
    }
    return { supported: false, reason: "legacy_office" };
  }

  return { supported: false, reason: "unsupported_type" };
}

export function looksLikeReadableText(text: string): boolean {
  if (!text.trim()) return false;
  const sample = text.slice(0, 4096);
  const trimmedSample = sample.trimStart();
  if (
    trimmedSample.startsWith("%PDF-") ||
    trimmedSample.startsWith("PK\u0003\u0004") ||
    trimmedSample.startsWith("\u0089PNG") ||
    trimmedSample.startsWith("GIF87a") ||
    trimmedSample.startsWith("GIF89a")
  ) {
    return false;
  }
  if (sample.includes("\u0000")) return false;

  const controlCharacters = Array.from(sample).filter((character) => {
    const code = character.charCodeAt(0);
    return code < 32 && !["\n", "\r", "\t"].includes(character);
  });
  return controlCharacters.length / sample.length < 0.02;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (102.4 * 1024)) / 10} MB`;
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf(".");
  if (index < 0) return "";
  return name.slice(index).toLowerCase();
}

const supportedNativeMimeTypes = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet"
]);

const legacyOfficeMimeTypes = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint"
]);
