import {
  ApprovedFact,
  CandidateStatus,
  FactLifecycleAction,
  FactMetadataUpdate,
  LifeContextDomain,
  SensitivityTier,
  SourceBodyUpdate,
  SourceLifecycleAction,
  SourceMetadataUpdate,
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

export interface NativeDocumentExtractionResult {
  text: string;
  detectedKind: string;
  warnings: string[];
  generatedBy: "native_document_extractor";
}

export interface NativeDocumentExtractionCapabilities {
  nativeDocumentExtraction: boolean;
  ocrExtraction: boolean;
  ocrProviderLabel: string | null;
  legacyOfficeConversion: boolean;
  legacyOfficeProviderLabel: string | null;
}

export interface NativeLocalProviderCandidate {
  label: string;
  command: string;
  args: string;
  timeoutSeconds: number;
  source: string;
}

export type NativeOcrProviderCandidate = NativeLocalProviderCandidate;
export type NativeLegacyOfficeProviderCandidate = NativeLocalProviderCandidate;

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

/**
 * Export the entire vault as an encrypted backup envelope (PBKDF2-SHA256 +
 * AES-GCM-256). The envelope contains every raw source, so it is as sensitive
 * as the vault itself; the passphrase protects it. Returns null in the browser
 * preview (which has no native vault).
 */
export async function exportNativeEncryptedBackup(passphrase: string): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("export_native_encrypted_backup", { passphrase });
}

/**
 * Restore a vault from an encrypted backup envelope. Overwrites the current
 * vault on disk; callers must confirm destructively before invoking. Returns
 * the restored, normalized vault state so the UI can refresh. Returns null in
 * the browser preview.
 */
export async function importNativeEncryptedBackup(
  backupText: string,
  passphrase: string
): Promise<VaultState | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const payload = await invoke<string>("import_native_encrypted_backup", { backupText, passphrase });
  return normalizeVaultState(JSON.parse(payload));
}

export async function extractNativeDocumentText(input: {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  ocrCommand?: string | null;
  ocrArgs?: string | null;
  ocrTimeoutSeconds?: number | null;
  legacyOfficeCommand?: string | null;
  legacyOfficeArgs?: string | null;
  legacyOfficeTimeoutSeconds?: number | null;
}): Promise<NativeDocumentExtractionResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeDocumentExtractionResult>("extract_native_document_text", input);
}

export async function getNativeDocumentExtractionCapabilities(): Promise<NativeDocumentExtractionCapabilities | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeDocumentExtractionCapabilities>("native_document_extraction_capabilities");
}

export async function detectNativeOcrProviderCandidates(): Promise<NativeOcrProviderCandidate[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeOcrProviderCandidate[]>("detect_ocr_provider_candidates");
}

export async function detectNativeLegacyOfficeProviderCandidates(): Promise<NativeLegacyOfficeProviderCandidate[]> {
  if (!isTauriRuntime()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeLegacyOfficeProviderCandidate[]>("detect_legacy_office_provider_candidates");
}

export type AiAccessRelayMode = "local_managed" | "hosted_agent" | "local_external" | "offline" | "unknown";
export type AgentRuntimeState = "connecting" | "connected" | "disconnected" | "unknown";

export interface AgentRuntimeStatus {
  state: AgentRuntimeState;
  relayBaseUrl: string | null;
  updatedAt: number | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  statusToken: string | null;
  processId: number | null;
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
  relayMode: AiAccessRelayMode;
  agentRuntimeStatus: AgentRuntimeStatus | null;
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

interface NativeContextPackMutationPayload {
  payload: string;
  updatedAt: string | null;
  requestId: string | null;
  packId: string | null;
  generatedBy: "native_vault_core";
}

export interface RelayContextPackHandoffResult {
  stored: boolean;
  requestId: string;
  expiresAt: number | null;
  ttlSeconds: number | null;
  state: VaultState | null;
  updatedAt: string | null;
  generatedBy: "native_relay_handoff";
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
  supersededFactIds: string[];
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

interface NativePassiveCapturePayload {
  payload: string;
  updatedAt: string | null;
  accepted: boolean;
  status: "capture_paused" | "site_not_allowed" | "captured" | "candidate_generated" | "ignored";
  message: string;
  eventId: string | null;
  sourceId: string | null;
  candidateIds: string[];
  detectedSensitivity: SensitivityTier;
  retentionUntil: string | null;
  generatedBy: "native_vault_core";
}

interface NativeVaultSettingsUpdatePayload {
  payload: string;
  updatedAt: string | null;
  generatedBy: "native_vault_core";
}

interface NativeSourceLifecyclePayload {
  payload: string;
  updatedAt: string | null;
  sourceId: string;
  action: SourceLifecycleAction;
  affectedCandidateCount: number;
  affectedFactCount: number;
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

interface NativeSourceMetadataPayload {
  payload: string;
  updatedAt: string | null;
  sourceId: string;
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

interface NativeSourceBodyPayload {
  payload: string;
  updatedAt: string | null;
  sourceId: string;
  candidateIds: string[];
  affectedCandidateCount: number;
  affectedFactCount: number;
  invalidatedPackCount: number;
  detectedSensitivity: SensitivityTier;
  generatedBy: "native_vault_core";
}

interface NativeFactLifecyclePayload {
  payload: string;
  updatedAt: string | null;
  factId: string;
  action: FactLifecycleAction;
  status: ApprovedFact["status"];
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

interface NativeFactMetadataPayload {
  payload: string;
  updatedAt: string | null;
  factId: string;
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

export interface NativeContextPackBuildResult {
  state: VaultState;
  updatedAt: string | null;
  requestId: string;
  packId: string | null;
  generatedBy: "native_vault_core";
}

export interface NativeContextPackMutationResult {
  state: VaultState;
  updatedAt: string | null;
  requestId: string | null;
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
  supersededFactIds: string[];
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

export interface NativePassiveCaptureResult {
  state: VaultState;
  updatedAt: string | null;
  accepted: boolean;
  status: NativePassiveCapturePayload["status"];
  message: string;
  eventId: string | null;
  sourceId: string | null;
  candidateIds: string[];
  detectedSensitivity: SensitivityTier;
  retentionUntil: string | null;
  generatedBy: "native_vault_core";
}

export interface NativeVaultSettingsUpdateResult {
  state: VaultState;
  updatedAt: string | null;
  generatedBy: "native_vault_core";
}

export interface NativeSourceLifecycleResult {
  state: VaultState;
  updatedAt: string | null;
  sourceId: string;
  action: SourceLifecycleAction;
  affectedCandidateCount: number;
  affectedFactCount: number;
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

export interface NativeSourceMetadataResult {
  state: VaultState;
  updatedAt: string | null;
  sourceId: string;
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

export interface NativeSourceBodyResult {
  state: VaultState;
  updatedAt: string | null;
  sourceId: string;
  candidateIds: string[];
  affectedCandidateCount: number;
  affectedFactCount: number;
  invalidatedPackCount: number;
  detectedSensitivity: SensitivityTier;
  generatedBy: "native_vault_core";
}

export interface NativeFactLifecycleResult {
  state: VaultState;
  updatedAt: string | null;
  factId: string;
  action: FactLifecycleAction;
  status: ApprovedFact["status"];
  invalidatedPackCount: number;
  generatedBy: "native_vault_core";
}

export interface NativeFactMetadataResult {
  state: VaultState;
  updatedAt: string | null;
  factId: string;
  invalidatedPackCount: number;
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

/**
 * Request a managed-relay pairing URL from the operator's hosted relay
 * (`POST /pair`, no admin token). The returned `agentWebSocketUrl` is then
 * passed to `startAiAccessAgentForRelay` to complete one-click pairing.
 */
export async function requestManagedPairingUrl(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("request_managed_pairing_url");
}

export async function startAiAccessAgentForRelay(agentWebsocketUrl: string): Promise<AiAccessServiceStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AiAccessServiceStatus>("start_ai_access_agent_for_relay", {
    agentWebsocketUrl
  });
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

export async function updateNativeContextPackItemVisibility(input: {
  packId: string;
  factId: string;
  included: boolean;
}): Promise<NativeContextPackMutationResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeContextPackMutationPayload>(
    "update_native_context_pack_item_visibility",
    {
      packId: input.packId,
      factId: input.factId,
      included: input.included
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

export async function confirmNativeContextPack(packId: string): Promise<NativeContextPackMutationResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeContextPackMutationPayload>("confirm_native_context_pack", {
    packId
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    requestId: result.requestId,
    packId: result.packId,
    generatedBy: result.generatedBy
  };
}

export async function handoffConfirmedContextPackToRelay(input: {
  clientId: string;
  requestId: string;
}): Promise<RelayContextPackHandoffResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<Omit<RelayContextPackHandoffResult, "state"> & { payload?: string | null }>("handoff_confirmed_context_pack_to_relay", {
    clientId: input.clientId,
    requestId: input.requestId
  });
  return {
    ...result,
    state: result.payload ? normalizeVaultState(JSON.parse(result.payload)) : null
  };
}

export async function denyNativeContextPackRequest(
  requestId: string
): Promise<NativeContextPackMutationResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeContextPackMutationPayload>("deny_native_context_pack_request", {
    requestId
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    requestId: result.requestId,
    packId: result.packId,
    generatedBy: result.generatedBy
  };
}

export async function addNativeSourcePendingRuntime(input: {
  kind: SourceKind;
  origin: SourceOrigin;
  title: string;
}): Promise<NativeSourceIngestResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeSourceIngestPayload>("add_native_source_pending_runtime", {
    kind: input.kind,
    origin: input.origin,
    title: input.title
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    sourceId: result.sourceId,
    candidateIds: result.candidateIds,
    detectedSensitivity: result.detectedSensitivity,
    generatedBy: "native_vault_core"
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
  supersedeFactIds?: string[];
}): Promise<NativeCandidateReviewResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeCandidateReviewPayload>("approve_native_candidate", {
    candidateId: input.candidateId,
    editedText: input.editedText ?? null,
    supersedeFactIds: input.supersedeFactIds ?? []
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    candidateId: result.candidateId,
    status: result.status,
    factId: result.factId,
    supersededFactIds: result.supersededFactIds,
    invalidatedPackCount: result.invalidatedPackCount,
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
    supersededFactIds: result.supersededFactIds,
    invalidatedPackCount: result.invalidatedPackCount,
    generatedBy: result.generatedBy
  };
}

export async function addNativePassiveCaptureEvent(input: {
  sourceClient: string;
  conversationId: string;
  url: string;
  text: string;
  pageTitle?: string;
  selected?: boolean;
}): Promise<NativePassiveCaptureResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativePassiveCapturePayload>("add_native_passive_capture_event", {
    sourceClient: input.sourceClient,
    conversationId: input.conversationId,
    url: input.url,
    text: input.text,
    pageTitle: input.pageTitle ?? null,
    selected: input.selected ?? false
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    accepted: result.accepted,
    status: result.status,
    message: result.message,
    eventId: result.eventId,
    sourceId: result.sourceId,
    candidateIds: result.candidateIds,
    detectedSensitivity: result.detectedSensitivity,
    retentionUntil: result.retentionUntil,
    generatedBy: result.generatedBy
  };
}

export async function updateNativePassiveCaptureSettings(input: {
  enabled?: boolean;
  retentionDays?: number;
  allowedSites?: string[];
}): Promise<NativeVaultSettingsUpdateResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeVaultSettingsUpdatePayload>(
    "update_native_passive_capture_settings",
    {
      enabled: input.enabled ?? null,
      retentionDays: input.retentionDays ?? null,
      allowedSites: input.allowedSites ?? null
    }
  );
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeAccessPolicy(input: {
  clientId: string;
  sensitivityCeiling?: SensitivityTier;
  requiresApprovalAbove?: SensitivityTier;
  domainAllowlist?: LifeContextDomain[];
  passiveCaptureAllowed?: boolean;
}): Promise<NativeVaultSettingsUpdateResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeVaultSettingsUpdatePayload>("update_native_access_policy", {
    clientId: input.clientId,
    sensitivityCeiling: input.sensitivityCeiling ?? null,
    requiresApprovalAbove: input.requiresApprovalAbove ?? null,
    domainAllowlist: input.domainAllowlist ?? null,
    passiveCaptureAllowed: input.passiveCaptureAllowed ?? null
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeSourceLifecycle(input: {
  sourceId: string;
  action: SourceLifecycleAction;
}): Promise<NativeSourceLifecycleResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeSourceLifecyclePayload>("update_native_source_lifecycle", {
    sourceId: input.sourceId,
    action: input.action
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    sourceId: result.sourceId,
    action: result.action,
    affectedCandidateCount: result.affectedCandidateCount,
    affectedFactCount: result.affectedFactCount,
    invalidatedPackCount: result.invalidatedPackCount,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeSourceMetadata(
  sourceId: string,
  input: SourceMetadataUpdate
): Promise<NativeSourceMetadataResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeSourceMetadataPayload>("update_native_source_metadata", {
    sourceId,
    title: input.title,
    defaultSensitivity: input.defaultSensitivity,
    promotedToLongTerm: input.promotedToLongTerm ?? null
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    sourceId: result.sourceId,
    invalidatedPackCount: result.invalidatedPackCount,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeSourceBody(
  sourceId: string,
  input: SourceBodyUpdate
): Promise<NativeSourceBodyResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeSourceBodyPayload>("update_native_source_body", {
    sourceId,
    body: input.body
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    sourceId: result.sourceId,
    candidateIds: result.candidateIds,
    affectedCandidateCount: result.affectedCandidateCount,
    affectedFactCount: result.affectedFactCount,
    invalidatedPackCount: result.invalidatedPackCount,
    detectedSensitivity: result.detectedSensitivity,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeFactLifecycle(input: {
  factId: string;
  action: FactLifecycleAction;
}): Promise<NativeFactLifecycleResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeFactLifecyclePayload>("update_native_fact_lifecycle", {
    factId: input.factId,
    action: input.action
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    factId: result.factId,
    action: result.action,
    status: result.status,
    invalidatedPackCount: result.invalidatedPackCount,
    generatedBy: result.generatedBy
  };
}

export async function updateNativeFactMetadata(
  factId: string,
  input: FactMetadataUpdate
): Promise<NativeFactMetadataResult | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<NativeFactMetadataPayload>("update_native_fact_metadata", {
    factId,
    factText: input.factText,
    domain: input.domain,
    sensitivity: input.sensitivity,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    dueDate: input.dueDate ?? null
  });
  return {
    state: normalizeVaultState(JSON.parse(result.payload)),
    updatedAt: result.updatedAt,
    factId: result.factId,
    invalidatedPackCount: result.invalidatedPackCount,
    generatedBy: result.generatedBy
  };
}
