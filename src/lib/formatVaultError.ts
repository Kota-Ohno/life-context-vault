/**
 * Surface the real cause of a Vault Core failure to the user.
 *
 * Tauri 2's `invoke()` rejects with the serialized `Err` value of the Rust
 * command. For commands returning `Result<T, String>` that is a **bare JS
 * string**, not an `Error` — so the common `error instanceof Error ? message :
 * fallback` guard silently swallows it and shows only the generic fallback.
 * That hid real causes like "ContextPack has expired" behind
 * "Vault Coreで…できませんでした", making failures impossible to diagnose.
 *
 * This helper surfaces whatever useful text the rejection carries, falling
 * back only when there is genuinely nothing to show.
 */
export function formatVaultError(error: unknown, fallback: string): string {
  if (typeof error === "string") {
    return error.trim().length > 0 ? error : fallback;
  }
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? error.message : fallback;
  }
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
}
