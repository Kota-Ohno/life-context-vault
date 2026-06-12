import {
  ApprovedFact,
  LifeContextDomain,
  SensitivityTier,
  VaultState
} from "./types";
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

export interface ClaudeDesktopConfigInstallResult {
  configPath: string;
  backupPath: string | null;
  serverName: string;
  alreadyConfigured: boolean;
}

export interface BrowserCaptureHostInstallResult {
  manifestPath: string;
  backupPath: string | null;
  hostName: string;
  hostPath: string;
  extensionId: string;
  alreadyConfigured: boolean;
}

export interface LoginItemStatus {
  supported: boolean;
  enabled: boolean;
  plistPath: string | null;
  programPath: string | null;
  label: string;
  backupPath: string | null;
  lastError: string | null;
}

export type NativeFactSearchResult = ApprovedFact & {
  rank: number;
};

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

export async function installClaudeDesktopConfig(): Promise<ClaudeDesktopConfigInstallResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ClaudeDesktopConfigInstallResult>("install_claude_desktop_config");
}

export async function getClaudeDesktopConfigTemplate(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("claude_desktop_config_template");
}

export async function installChromeCaptureHostManifest(
  extensionId: string
): Promise<BrowserCaptureHostInstallResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BrowserCaptureHostInstallResult>("install_chrome_capture_host_manifest", {
    extensionId
  });
}

export async function getLoginItemStatus(): Promise<LoginItemStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoginItemStatus>("login_item_status");
}

export async function installLoginItem(): Promise<LoginItemStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoginItemStatus>("install_login_item");
}

export async function uninstallLoginItem(): Promise<LoginItemStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LoginItemStatus>("uninstall_login_item");
}

export async function searchNativeFacts(options: {
  query: string;
  domain: LifeContextDomain | "all";
  sensitivity: SensitivityTier | "all";
  limit?: number;
}): Promise<NativeFactSearchResult[] | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeFactSearchResult[]>("search_vault_facts", {
    query: options.query,
    domain: options.domain === "all" ? null : options.domain,
    sensitivity: options.sensitivity === "all" ? null : options.sensitivity,
    limit: options.limit ?? 80
  });
}
