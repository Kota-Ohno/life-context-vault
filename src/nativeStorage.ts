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

export interface AiAccessServiceStatus {
  managedByApp: boolean;
  relayManagedRunning: boolean;
  agentManagedRunning: boolean;
  relayReachable: boolean;
  agentConnected: boolean;
  relayUrl: string;
  mcpServerUrl: string;
  relayStateStatusUrl: string;
  pairingCode: string | null;
  lastError: string | null;
}

export async function getAiAccessServiceStatus(): Promise<AiAccessServiceStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AiAccessServiceStatus>("ai_access_service_status");
}

export async function startAiAccessServices(): Promise<AiAccessServiceStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AiAccessServiceStatus>("start_ai_access_services");
}

export async function stopAiAccessServices(): Promise<AiAccessServiceStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AiAccessServiceStatus>("stop_ai_access_services");
}
