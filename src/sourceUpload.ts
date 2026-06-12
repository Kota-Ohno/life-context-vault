export const MAX_TEXT_SOURCE_BYTES = 2 * 1024 * 1024;

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

export const SUPPORTED_TEXT_SOURCE_ACCEPT = SUPPORTED_TEXT_SOURCE_EXTENSIONS.join(",");
export const SUPPORTED_TEXT_SOURCE_LABEL = "TXT, MD, CSV, TSV, JSON, YAML, LOG";

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
