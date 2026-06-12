import {
  ApprovedFact,
  CandidateStatus,
  LifeContextDomain,
  SensitivityTier,
  SourceKind,
  SourceOrigin,
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

interface NativeContextPackBuildPayload {
  payload: string;
  updatedAt: string | null;
  requestId: string;
  packId: string | null;
  generatedBy: "native_vault_core";
}

interface NativeSourceIngestPayload {
  payload: string;
  updatedAt: string | null;
  sourceId: string;
  candidateIds: string[];
  detectedSensitivity: SensitivityTier;
  generatedBy: "native_vault_core";
}

interface NativeCandidateReviewPayload {
  payload: string;
  updatedAt: string | null;
  candidateId: string;
  status: CandidateStatus;
  factId: string | null;
  generatedBy: "native_vault_core";
}

export interface NativeContextPackBuildResult {
  state: VaultState;
  updatedAt: string | null;
  requestId: string;
  packId: string | null;
  generatedBy: "native_vault_core";
}

export interface NativeSourceIngestResult {
  state: VaultState;
  updatedAt: string | null;
  sourceId: string;
  candidateIds: string[];
  detectedSensitivity: SensitivityTier;
  generatedBy: "native_vault_core";
}

export interface NativeCandidateReviewResult {
  state: VaultState;
  updatedAt: string | null;
  candidateId: string;
  status: CandidateStatus;
  factId: string | null;
  generatedBy: "native_vault_core";
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

export async function createNativeContextPackRequest(input: {
  clientId: string;
  clientName: string;
  taskText: string;
  purpose?: string;
  sensitivityCeiling?: SensitivityTier;
  approvalMode?: "auto_low_risk" | "always_review" | "explicit_sensitive";
}): Promise<NativeContextPackBuildResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeContextPackBuildPayload>(
    "create_native_context_pack_request",
    {
      clientId: input.clientId,
      clientName: input.clientName,
      taskText: input.taskText,
      purpose: input.purpose ?? null,
      sensitivityCeiling: input.sensitivityCeiling ?? null,
      approvalMode: input.approvalMode ?? null
    }
  );
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    requestId: result.requestId,
    packId: result.packId,
    generatedBy: result.generatedBy
  };
}

export async function addNativeSourceWithCandidates(input: {
  kind: SourceKind;
  origin: SourceOrigin;
  title: string;
  body: string;
}): Promise<NativeSourceIngestResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeSourceIngestPayload>("add_native_source_with_candidates", {
    kind: input.kind,
    origin: input.origin,
    title: input.title,
    body: input.body
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    sourceId: result.sourceId,
    candidateIds: result.candidateIds,
    detectedSensitivity: result.detectedSensitivity,
    generatedBy: result.generatedBy
  };
}

export async function approveNativeCandidate(input: {
  candidateId: string;
  editedText?: string;
}): Promise<NativeCandidateReviewResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeCandidateReviewPayload>("approve_native_candidate", {
    candidateId: input.candidateId,
    editedText: input.editedText ?? null
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    candidateId: result.candidateId,
    status: result.status,
    factId: result.factId,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeCandidateStatus(input: {
  candidateId: string;
  status: CandidateStatus;
}): Promise<NativeCandidateReviewResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeCandidateReviewPayload>("update_native_candidate_status", {
    candidateId: input.candidateId,
    status: input.status
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    candidateId: result.candidateId,
    status: result.status,
    factId: result.factId,
    generatedBy: result.generatedBy
  };
}
