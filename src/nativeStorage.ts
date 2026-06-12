import { VaultState } from "./types";
import { normalizeVaultState } from "./vault";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function loadNativeVault(): Promise<VaultState | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<string | null>("load_vault_state");
  if (!raw) return null;
  return normalizeVaultState(JSON.parse(raw));
}

export async function saveNativeVault(state: VaultState): Promise<void> {
  if (!isTauriRuntime()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_vault_state", { payload: JSON.stringify(state) });
}

export async function getNativeVaultPath(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("vault_storage_path");
}
