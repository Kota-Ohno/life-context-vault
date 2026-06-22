import { describe, expect, test } from "vitest";
import { formatVaultError } from "./formatVaultError";

describe("formatVaultError", () => {
  const fallback = "Vault Coreで操作を完了できませんでした。";

  test("Tauri Err(String) rejection: plain string surfaced as-is", () => {
    // Tauri 2 invoke() rejects with the serialized Err value. For Result<T, String>,
    // that is a bare JS string — the case that the old `error instanceof Error`
    // guard silently swallowed, hiding the real cause behind the fallback.
    expect(formatVaultError("ContextPack has expired. Create a new request.", fallback)).toBe(
      "ContextPack has expired. Create a new request."
    );
  });

  test("JS Error surfaces its message", () => {
    expect(formatVaultError(new Error("boom"), fallback)).toBe("boom");
  });

  test("object with message string surfaces the message", () => {
    expect(formatVaultError({ message: "policy denied" }, fallback)).toBe("policy denied");
  });

  test("unknown / null / undefined falls back", () => {
    expect(formatVaultError(undefined, fallback)).toBe(fallback);
    expect(formatVaultError(null, fallback)).toBe(fallback);
    expect(formatVaultError(42, fallback)).toBe(fallback);
  });

  test("empty string falls back rather than showing a blank notice", () => {
    expect(formatVaultError("", fallback)).toBe(fallback);
  });

  test("object with empty message falls back", () => {
    expect(formatVaultError({ message: "" }, fallback)).toBe(fallback);
  });
});
