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
import { RuntimePreferences } from "./runtimePreferences";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/**
 * The single Tauri IPC entry point. Returns null outside the Tauri runtime
 * (browser preview / tests) — this silent-null contract is centralized HERE so
 * every command shares it and callers handle a single, well-known sentinel.
 */
async function invokeNative<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Convert any core payload that carries a JSON `payload` string into the
 * UI-facing shape with a parsed, normalized `state`. */
function withState<P extends { payload: string }>(
  result: P
): Omit<P, "payload"> & { state: VaultState } {
  const { payload, ...rest } = result;
  return { ...rest, state: normalizeVaultState(JSON.parse(payload)) };
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
  const snapshot = await invokeNative<NativeVaultSnapshotPayload>("load_vault_state_snapshot");
  if (!snapshot) return null;
  return {
    state: snapshot.payload ? normalizeVaultState(JSON.parse(snapshot.payload)) : null,
    updatedAt: snapshot.updatedAt
  };
}

export async function saveNativeVault(
  state: VaultState,
  expectedUpdatedAt: string | null
): Promise<SaveNativeVaultResult | null> {
  const result = await invokeNative<SaveNativeVaultPayload>("save_vault_state", {
    payload: JSON.stringify(state),
    expectedUpdatedAt
  });
  if (!result) return null;
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
  return invokeNative<string>("vault_storage_path");
}

/**
 * Export the entire vault as an encrypted backup envelope (PBKDF2-SHA256 +
 * AES-GCM-256). The envelope contains every raw source, so it is as sensitive
 * as the vault itself; the passphrase protects it. Returns null in the browser
 * preview (which has no native vault).
 */
export async function exportNativeEncryptedBackup(passphrase: string): Promise<string | null> {
  return invokeNative<string>("export_native_encrypted_backup", { passphrase });
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
  const payload = await invokeNative<string>("import_native_encrypted_backup", {
    backupText,
    passphrase
  });
  return payload ? normalizeVaultState(JSON.parse(payload)) : null;
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
  return invokeNative<NativeDocumentExtractionResult>("extract_native_document_text", input);
}

export async function getNativeDocumentExtractionCapabilities(): Promise<NativeDocumentExtractionCapabilities | null> {
  return invokeNative<NativeDocumentExtractionCapabilities>(
    "native_document_extraction_capabilities"
  );
}

export async function detectNativeOcrProviderCandidates(): Promise<NativeOcrProviderCandidate[]> {
  return (await invokeNative<NativeOcrProviderCandidate[]>("detect_ocr_provider_candidates")) ?? [];
}

export async function detectNativeLegacyOfficeProviderCandidates(): Promise<NativeLegacyOfficeProviderCandidate[]> {
  return (
    (await invokeNative<NativeLegacyOfficeProviderCandidate[]>(
      "detect_legacy_office_provider_candidates"
    )) ?? []
  );
}

export interface ClaudeDesktopConfigInstallResult {
  configPath: string;
  backupPath: string | null;
  serverName: string;
  alreadyConfigured: boolean;
  warning?: string | null;
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

// The UI-facing *Result shapes are the payload shapes with the JSON `payload`
// string swapped for a parsed `state`. Deriving them keeps the field lists in
// one place — adding a field to a payload now forces the mapping to follow (tsc
// errors otherwise) instead of silently drifting.
export type NativeContextPackBuildResult = Omit<NativeContextPackBuildPayload, "payload"> & {
  state: VaultState;
};
export type NativeContextPackMutationResult = Omit<NativeContextPackMutationPayload, "payload"> & {
  state: VaultState;
};
export type NativeSourceIngestResult = Omit<NativeSourceIngestPayload, "payload"> & {
  state: VaultState;
};
export type NativeCandidateReviewResult = Omit<NativeCandidateReviewPayload, "payload"> & {
  state: VaultState;
};
export type NativeVaultSettingsUpdateResult = Omit<NativeVaultSettingsUpdatePayload, "payload"> & {
  state: VaultState;
};
export type NativeSourceLifecycleResult = Omit<NativeSourceLifecyclePayload, "payload"> & {
  state: VaultState;
};
export type NativeSourceMetadataResult = Omit<NativeSourceMetadataPayload, "payload"> & {
  state: VaultState;
};
export type NativeSourceBodyResult = Omit<NativeSourceBodyPayload, "payload"> & {
  state: VaultState;
};
export type NativeFactLifecycleResult = Omit<NativeFactLifecyclePayload, "payload"> & {
  state: VaultState;
};
export type NativeFactMetadataResult = Omit<NativeFactMetadataPayload, "payload"> & {
  state: VaultState;
};

export async function writeNativeRecoveryEnvelope(recoveryKey: string): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  await invokeNative<void>("write_recovery_envelope", { recoveryKey });
  return true;
}

/** Recover the vault key from the sidecar and re-establish it in Keychain
 * (after a Keychain loss). Throws on a wrong recovery key. */
export async function recoverVaultWithRecoveryKey(recoveryKey: string): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  await invokeNative<void>("recover_vault_with_recovery_key", { recoveryKey });
  return true;
}

/** Write a vault-key-derived backup now to the default Backups directory. */
export async function runLocalBackupNow(): Promise<string | null> {
  return invokeNative<string>("run_local_backup_now");
}

/** Read runtime preferences (OCR/Office/autoStart) persisted in the vault. */
export async function getNativeRuntimePreferences(): Promise<Partial<RuntimePreferences> | null> {
  return invokeNative<Partial<RuntimePreferences>>("get_native_runtime_preferences");
}

/** Persist runtime preferences into the vault (so they survive reinstall and
 * migrate with encrypted backups). */
export async function saveNativeRuntimePreferences(
  preferences: RuntimePreferences
): Promise<boolean | null> {
  if (!isTauriRuntime()) return null;
  await invokeNative<void>("save_native_runtime_preferences", { prefs: preferences });
  return true;
}

/**
 * Persist the delivery-notifications opt-in flag.  Returns the persisted
 * value, or null outside Tauri.  The caller is responsible for requesting
 * OS permission via tauri-plugin-notification's `requestPermission()` when
 * enabling.
 */
export async function setNativeDeliveryNotificationsEnabled(
  enabled: boolean
): Promise<boolean | null> {
  return invokeNative<boolean>("set_delivery_notifications_enabled", { enabled });
}

/** Install the local Claude Desktop MCP config entry for lcv-mcp. */
export async function installClaudeDesktopConfig(): Promise<ClaudeDesktopConfigInstallResult | null> {
  return invokeNative<ClaudeDesktopConfigInstallResult>("install_claude_desktop_config");
}

export async function getClaudeDesktopConfigTemplate(): Promise<string | null> {
  return invokeNative<string>("claude_desktop_config_template");
}

export async function getLoginItemStatus(): Promise<LoginItemStatus | null> {
  return invokeNative<LoginItemStatus>("login_item_status");
}

export async function installLoginItem(): Promise<LoginItemStatus | null> {
  return invokeNative<LoginItemStatus>("install_login_item");
}

export async function uninstallLoginItem(): Promise<LoginItemStatus | null> {
  return invokeNative<LoginItemStatus>("uninstall_login_item");
}

export async function searchNativeFacts(options: {
  query: string;
  domain: LifeContextDomain | "all";
  sensitivity: SensitivityTier | "all";
  limit?: number;
}): Promise<NativeFactSearchResult[] | null> {
  return invokeNative<NativeFactSearchResult[]>("search_vault_facts", {
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
  const result = await invokeNative<NativeContextPackBuildPayload>(
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
  return result ? withState(result) : null;
}

export async function updateNativeContextPackItemVisibility(input: {
  packId: string;
  factId: string;
  included: boolean;
}): Promise<NativeContextPackMutationResult | null> {
  const result = await invokeNative<NativeContextPackMutationPayload>(
    "update_native_context_pack_item_visibility",
    {
      packId: input.packId,
      factId: input.factId,
      included: input.included
    }
  );
  return result ? withState(result) : null;
}

export async function confirmNativeContextPack(
  packId: string
): Promise<NativeContextPackMutationResult | null> {
  const result = await invokeNative<NativeContextPackMutationPayload>(
    "confirm_native_context_pack",
    { packId }
  );
  return result ? withState(result) : null;
}

export async function denyNativeContextPackRequest(
  requestId: string
): Promise<NativeContextPackMutationResult | null> {
  const result = await invokeNative<NativeContextPackMutationPayload>(
    "deny_native_context_pack_request",
    { requestId }
  );
  return result ? withState(result) : null;
}

export async function addNativeSourcePendingRuntime(input: {
  kind: SourceKind;
  origin: SourceOrigin;
  title: string;
}): Promise<NativeSourceIngestResult | null> {
  const result = await invokeNative<NativeSourceIngestPayload>("add_native_source_pending_runtime", {
    kind: input.kind,
    origin: input.origin,
    title: input.title
  });
  return result ? withState(result) : null;
}

export async function addNativeSourceWithCandidates(input: {
  kind: SourceKind;
  origin: SourceOrigin;
  title: string;
  body: string;
}): Promise<NativeSourceIngestResult | null> {
  const result = await invokeNative<NativeSourceIngestPayload>("add_native_source_with_candidates", {
    kind: input.kind,
    origin: input.origin,
    title: input.title,
    body: input.body
  });
  return result ? withState(result) : null;
}

export async function approveNativeCandidate(input: {
  candidateId: string;
  editedText?: string;
  supersedeFactIds?: string[];
}): Promise<NativeCandidateReviewResult | null> {
  const result = await invokeNative<NativeCandidateReviewPayload>("approve_native_candidate", {
    candidateId: input.candidateId,
    editedText: input.editedText ?? null,
    supersedeFactIds: input.supersedeFactIds ?? []
  });
  return result ? withState(result) : null;
}

export async function updateNativeCandidateStatus(input: {
  candidateId: string;
  status: CandidateStatus;
}): Promise<NativeCandidateReviewResult | null> {
  const result = await invokeNative<NativeCandidateReviewPayload>("update_native_candidate_status", {
    candidateId: input.candidateId,
    status: input.status
  });
  return result ? withState(result) : null;
}

export async function updateNativeAccessPolicy(input: {
  clientId: string;
  sensitivityCeiling?: SensitivityTier;
  requiresApprovalAbove?: SensitivityTier;
  domainAllowlist?: LifeContextDomain[];
  passiveCaptureAllowed?: boolean;
}): Promise<NativeVaultSettingsUpdateResult | null> {
  const result = await invokeNative<NativeVaultSettingsUpdatePayload>("update_native_access_policy", {
    clientId: input.clientId,
    sensitivityCeiling: input.sensitivityCeiling ?? null,
    requiresApprovalAbove: input.requiresApprovalAbove ?? null,
    domainAllowlist: input.domainAllowlist ?? null,
    passiveCaptureAllowed: input.passiveCaptureAllowed ?? null
  });
  return result ? withState(result) : null;
}

export async function setNativeConnectionStandingDelivery(input: {
  clientId: string;
  enabled: boolean;
}): Promise<NativeVaultSettingsUpdateResult | null> {
  const result = await invokeNative<NativeVaultSettingsUpdatePayload>(
    "set_connection_standing_delivery",
    {
      clientId: input.clientId,
      enabled: input.enabled
    }
  );
  return result ? withState(result) : null;
}

export async function updateNativeSourceLifecycle(input: {
  sourceId: string;
  action: SourceLifecycleAction;
}): Promise<NativeSourceLifecycleResult | null> {
  const result = await invokeNative<NativeSourceLifecyclePayload>("update_native_source_lifecycle", {
    sourceId: input.sourceId,
    action: input.action
  });
  return result ? withState(result) : null;
}

export async function updateNativeSourceMetadata(
  sourceId: string,
  input: SourceMetadataUpdate
): Promise<NativeSourceMetadataResult | null> {
  const result = await invokeNative<NativeSourceMetadataPayload>("update_native_source_metadata", {
    sourceId,
    title: input.title,
    defaultSensitivity: input.defaultSensitivity,
    promotedToLongTerm: input.promotedToLongTerm ?? null
  });
  return result ? withState(result) : null;
}

export async function updateNativeSourceBody(
  sourceId: string,
  input: SourceBodyUpdate
): Promise<NativeSourceBodyResult | null> {
  const result = await invokeNative<NativeSourceBodyPayload>("update_native_source_body", {
    sourceId,
    body: input.body
  });
  return result ? withState(result) : null;
}

export async function updateNativeFactLifecycle(input: {
  factId: string;
  action: FactLifecycleAction;
}): Promise<NativeFactLifecycleResult | null> {
  const result = await invokeNative<NativeFactLifecyclePayload>("update_native_fact_lifecycle", {
    factId: input.factId,
    action: input.action
  });
  return result ? withState(result) : null;
}

export async function updateNativeFactMetadata(
  factId: string,
  input: FactMetadataUpdate
): Promise<NativeFactMetadataResult | null> {
  const result = await invokeNative<NativeFactMetadataPayload>("update_native_fact_metadata", {
    factId,
    factText: input.factText,
    domain: input.domain,
    sensitivity: input.sensitivity,
    validFrom: input.validFrom ?? null,
    validUntil: input.validUntil ?? null,
    dueDate: input.dueDate ?? null
  });
  return result ? withState(result) : null;
}
