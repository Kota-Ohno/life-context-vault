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

export interface NativeVaultSnapshot {
  state: VaultState | null;
  updatedAt: string | null;
}

interface NativeVaultSnapshotPayload {
  payload: string | null;
  updatedAt: string | null;
}

export interface SaveNativeVaultResult {
  updatedAt: string | null;
  conflict: boolean;
  currentUpdatedAt: string | null;
  currentState: VaultState | null;
}

interface SaveNativeVaultPayload {
  updatedAt: string | null;
  conflict: boolean;
  currentUpdatedAt: string | null;
  currentPayload: string | null;
}

export async function loadNativeVaultSnapshot(): Promise<NativeVaultSnapshot | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const snapshot = await invoke<NativeVaultSnapshotPayload>("load_vault_state_snapshot");
  return {
    state: snapshot.payload ? normalizeVaultState(JSON.parse(snapshot.payload)) : null,
    updatedAt: snapshot.updatedAt
  };
}

export async function loadNativeVault(): Promise<VaultState | null> {
  const snapshot = await loadNativeVaultSnapshot();
  return snapshot?.state ?? null;
}

export async function saveNativeVault(
  state: VaultState,
  expectedUpdatedAt: string | null
): Promise<SaveNativeVaultResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<SaveNativeVaultPayload>("save_vault_state", {
    payload: JSON.stringify(state),
    expectedUpdatedAt
  });
  return {
    updatedAt: result.updatedAt,
    conflict: result.conflict,
    currentUpdatedAt: result.currentUpdatedAt,
    currentState: result.currentPayload
      ? normalizeVaultState(JSON.parse(result.currentPayload))
      : null
  };
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
