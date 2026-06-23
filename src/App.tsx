import {
  Activity,
  Archive,
  ArrowRight,
  Bell,
  Check,
  CheckCircle2,
  Clipboard,
  CircleDot,
  Clock,
  Download,
  EyeOff,
  FileText,
  Home,
  Inbox,
  Lock,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Plug,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ClaudeDesktopConfigInstallResult,
  LoginItemStatus,
  NativeDocumentExtractionCapabilities,
  NativeLegacyOfficeProviderCandidate,
  NativeOcrProviderCandidate,
  addNativeSourceWithCandidates,
  addNativeSourcePendingRuntime,
  approveNativeCandidate,
  confirmNativeContextPack,
  createNativeContextPackRequest,
  denyNativeContextPackRequest,
  detectNativeLegacyOfficeProviderCandidates,
  detectNativeOcrProviderCandidates,
  extractNativeDocumentText,
  getClaudeDesktopConfigTemplate,
  getLoginItemStatus,
  getNativeDocumentExtractionCapabilities,
  getNativeVaultPath,
  installClaudeDesktopConfig,
  installLoginItem,
  loadNativeVaultSnapshot,
  saveNativeVault,
  searchNativeFacts,
  setNativeConnectionStandingDelivery,
  updateNativeAccessPolicy,
  updateNativeCandidateStatus,
  updateNativeContextPackItemVisibility,
  updateNativeFactLifecycle,
  updateNativeFactMetadata,
  updateNativeSourceMetadata,
  updateNativeSourceBody,
  updateNativeSourceLifecycle,
  uninstallLoginItem,
  exportNativeEncryptedBackup,
  importNativeEncryptedBackup,
  isTauriRuntime,
  getNativeRuntimePreferences,
  saveNativeRuntimePreferences,
  setNativeDeliveryNotificationsEnabled
} from "./nativeStorage";
import { detectLang, Lang, t } from "./i18n";
import { formatVaultError } from "./lib/formatVaultError";
import { Metric } from "./components/Metric";
import { Badge } from "./components/Badge";
import { SensitivityBadge } from "./components/SensitivityBadge";
import { EmptyState } from "./components/EmptyState";
import { ThemeToggle } from "./components/ThemeToggle";
import { Rail } from "./components/Rail";
import { QVGallery } from "./components/_gallery";
import { HomeTimeline } from "./components/HomeTimeline";
import { ConnectView } from "./views/ConnectView";
import { IngestView } from "./views/IngestView";
import { Toggle } from "./components/Toggle";
import { Card } from "./components/Card";
import { SectionDivider } from "./components/SectionDivider";
import { DetailsDisclosure } from "./components/DetailsDisclosure";
import { sensitivityBucketLabel } from "./sensitivityBuckets";
import { factMemoryStatus, memoryStatusLabel } from "./memoryStatus";
import {
  RuntimePreferences,
  loadRuntimePreferences,
  saveRuntimePreferences
} from "./runtimePreferences";
import {
  MAX_NATIVE_DOCUMENT_SOURCE_BYTES,
  MAX_TEXT_SOURCE_BYTES,
  LEGACY_OFFICE_EXTENSIONS,
  OCR_DOCUMENT_EXTENSIONS,
  SUPPORTED_SOURCE_ACCEPT,
  SUPPORTED_SOURCE_ACCEPT_WITH_OCR,
  SUPPORTED_SOURCE_LABEL,
  SUPPORTED_SOURCE_LABEL_WITH_OCR,
  SUPPORTED_TEXT_SOURCE_EXTENSIONS,
  SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS,
  describeSourceFile,
  formatFileSize,
  looksLikeReadableText
} from "./sourceUpload";
import {
  addSourceWithCandidates,
  addPassiveCaptureEvent,
  approveCandidate,
  attachLocalAnswer,
  buildContextPackForRequest,
  canSendContextPackToAi,
  confirmContextPack,
  createContextPackRequest,
  createEmptyVault,
  denyContextPackRequest,
  domainLabel,
  exportEncryptedBackup,
  generateLocalAnswer,
  importEncryptedBackup,
  loadVault,
  makeAiContextPackPayload,
  makeDemoVault,
  purgeExpiredPassiveCaptures,
  recordContextPackDelivery,
  saveContextPack,
  saveVault,
  searchFacts,
  sensitivityLabel,
  updateAccessPolicy,
  updateFactLifecycle,
  updateFactMetadata,
  updatePassiveCaptureSettings,
  updateCandidateStatus,
  updateContextPackItemVisibility,
  updateSourceMetadata,
  updateSourceBody,
  updateSourceLifecycle
} from "./vault";
import {
  ApprovedFact,
  AccessPolicy,
  CandidateStatus,
  ConnectorKind,
  ConnectorSession,
  ContextPack,
  ContextPackRequest,
  AuditEvent,
  FactLifecycleAction,
  FactMetadataUpdate,
  LifeContextDomain,
  MemoryCandidate,
  PassiveCaptureEvent,
  PassiveCaptureSettings,
  RawSource,
  SensitivityTier,
  SourceBodyUpdate,
  SourceLifecycleAction,
  SourceMetadataUpdate,
  SourceKind,
  SourceOrigin,
  VaultState
} from "./types";

type View =
  | "home"
  | "sources"
  | "connections"
  | "requests"
  | "search"
  | "settings";

type ConnectionDiagnosticTone = "ready" | "attention" | "blocked" | "neutral";

type ConnectionDiagnosticAction =
  | "open_desktop"
  | "start_ai_access"
  | "open_requests"
  | "refresh";

type ConnectionDiagnosticState = "ready" | "pending" | "blocked";

interface ConnectionDiagnosticItem {
  label: string;
  value: string;
  state: ConnectionDiagnosticState;
}

interface ConnectionDiagnostic {
  tone: ConnectionDiagnosticTone;
  title: string;
  summary: string;
  nextStep: string;
  issue: string | null;
  primaryAction: ConnectionDiagnosticAction;
  items: ConnectionDiagnosticItem[];
}

type ContextPackBoundaryTone = "ready" | "attention";

type ContextPackBoundaryReceiptItem = {
  label: string;
  tone: ContextPackBoundaryTone;
  value: string;
  detail: string;
};

type ContextPackDeliveryState = {
  canDeliver: boolean;
  closed: boolean;
  expired: boolean;
  confirmed: boolean;
  requiresApproval: boolean;
  awaitingReturn: boolean;
};

interface HomeCaptureSafetySummary {
  tone: "ready" | "attention";
  title: string;
  body: string;
  allowedSitesLabel: string;
  lastCaptureLabel: string;
  lastPreview: string | null;
  purgeableCount: number;
}

type SearchMode = "native_fts" | "browser_fallback" | "loading";

type UploadFeedback = {
  tone: "ready" | "attention";
  title: string;
  body: string;
};

type DocumentIngestionReadinessItem = {
  label: string;
  state: "ready" | "attention";
  value: string;
  detail: string;
};

type HomeAiBoundarySection = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "attention";
};

type RestorePreview = {
  generatedAt: string;
  counts: {
    sources: number;
    candidates: number;
    facts: number;
    requests: number;
    packs: number;
    captureEvents: number;
    connectorSessions: number;
    policies: number;
    auditEvents: number;
  };
  currentCounts: {
    sources: number;
    candidates: number;
    facts: number;
    requests: number;
    packs: number;
    captureEvents: number;
    connectorSessions: number;
    policies: number;
    auditEvents: number;
  };
  sensitivitySummary: string;
  newestSourceAt?: string;
  oldestAuditAt?: string;
  sourceBodyBytes: number;
  activeConnectorCount: number;
  pairedConnectorCount: number;
  expiredCaptureCount: number;
  promotedSourceCount: number;
  receiptSections: Array<{
    label: string;
    value: string;
    detail: string;
    tone: "ready" | "attention";
  }>;
  aiBoundarySections: Array<{
    label: string;
    value: string;
    detail: string;
    tone: "ready" | "attention";
  }>;
  overwriteSections: Array<{
    label: string;
    value: string;
    detail: string;
    tone: "ready" | "attention";
  }>;
};

type ClearImpactSection = {
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "attention";
};

type ManualCopyPayload = {
  packId: string;
  payloadText: string;
  createdAt: string;
};

const domainOptions: Array<LifeContextDomain | "all"> = [
  "all",
  "identity_and_profile",
  "values_goals_and_preferences",
  "life_events_and_plans",
  "routines_and_logistics",
  "home_and_places",
  "documents_and_evidence",
  "contracts_and_policies",
  "procedures_and_obligations",
  "health_and_care",
  "finance_and_benefits",
  "work_and_education",
  "relationships_and_household",
  "constraints_and_accessibility"
];

const policyDomainOptions = domainOptions.filter(
  (domain): domain is LifeContextDomain => domain !== "all"
);

const sensitivityOptions: Array<SensitivityTier | "all"> = [
  "all",
  "public",
  "personal",
  "private_consequential",
  "sensitive",
  "secret_never_send"
];

const policySensitivityOptions: SensitivityTier[] = [
  "public",
  "personal",
  "private_consequential",
  "sensitive"
];

const localMcpBinaryPath = "/Applications/Life Context Vault.app/Contents/MacOS/lcv-mcp";

/** Set to true to mount the QV component gallery at startup (dev only). */
const SHOW_QV_GALLERY = false;

/** Views that render their own Quiet Vault PageHeader — suppress the legacy topbar title for these. */
const VIEWS_WITH_OWN_HEADER = new Set(["home", "connections", "sources"]);

/** Human-readable labels for connector kinds. */
const CLIENT_LABELS: Record<string, string> = {
  claude_desktop: "Claude Desktop",
  chatgpt: "ChatGPT",
  claude_remote: "Claude (リモート)",
  gemini: "Gemini",
  codex: "Codex",
  generic_mcp: "MCP クライアント",
  browser_capture: "ブラウザキャプチャ",
  copy_fallback: "コピー経由",
};

export function App() {
  const [showGallery, setShowGallery] = useState(SHOW_QV_GALLERY);
  const [state, setState] = useState<VaultState>(() => loadVault());
  const [storageReady, setStorageReady] = useState(false);
  const [nativePath, setNativePath] = useState<string | null>(null);
  const [view, setView] = useState<View>("home");
  const [lang, setLang] = useState<Lang>(() => {
    const stored = typeof localStorage !== "undefined" ? localStorage.getItem("lcv-lang") : null;
    if (stored === "en" || stored === "ja") return stored;
    return detectLang();
  });
  useEffect(() => {
    try {
      localStorage.setItem("lcv-lang", lang);
    } catch {
      /* localStorage unavailable; language stays in-memory for this session */
    }
  }, [lang]);
  const [candidateEdits, setCandidateEdits] = useState<Record<string, string>>({});
  const [candidateSupersedes, setCandidateSupersedes] = useState<Record<string, string[]>>({});
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback | null>(null);
  const [question, setQuestion] = useState("");
  const [requestClientId, setRequestClientId] = useState("conn_chatgpt");
  const [activePackId, setActivePackId] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [manualCopyPayload, setManualCopyPayload] = useState<ManualCopyPayload | null>(null);
  const [captureClient, setCaptureClient] = useState<ConnectorKind>("chatgpt");
  const [captureConversationId, setCaptureConversationId] = useState("demo-thread");
  const [captureText, setCaptureText] = useState("");
  const [captureExtensionId, setCaptureExtensionId] = useState("");
  const [captureHostInstallBusy, setCaptureHostInstallBusy] = useState(false);
  const [captureHostInstallResult, setCaptureHostInstallResult] =
    useState<any | null>(null);
  const [confirmAllCapturePurge, setConfirmAllCapturePurge] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<LifeContextDomain | "all">("all");
  const [sensitivityFilter, setSensitivityFilter] = useState<SensitivityTier | "all">("all");
  const [nativeSearchResults, setNativeSearchResults] = useState<ApprovedFact[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>("browser_fallback");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupText, setBackupText] = useState("");
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  const [clearConfirmText, setClearConfirmText] = useState("");
  const [notice, setNotice] = useState("");
  const [documentExtractionCapabilities, setDocumentExtractionCapabilities] =
    useState<NativeDocumentExtractionCapabilities | null>(null);
  const [ocrProviderCandidates, setOcrProviderCandidates] = useState<NativeOcrProviderCandidate[]>([]);
  const [legacyOfficeProviderCandidates, setLegacyOfficeProviderCandidates] =
    useState<NativeLegacyOfficeProviderCandidate[]>([]);
  const [runtimePreferences, setRuntimePreferences] = useState<RuntimePreferences>(() =>
    loadRuntimePreferences()
  );
  const [loginItemStatus, setLoginItemStatus] = useState<LoginItemStatus | null>(null);
  const [loginItemBusy, setLoginItemBusy] = useState(false);
  const [nativeRevision, setNativeRevision] = useState<string | null>(null);
  const [claudeInstallBusy, setClaudeInstallBusy] = useState(false);
  const [claudeInstallResult, setClaudeInstallResult] =
    useState<ClaudeDesktopConfigInstallResult | null>(null);
  const [claudeConfig, setClaudeConfig] = useState(() => makeClaudeDesktopConfig(null));
  const nativeRevisionRef = useRef<string | null>(null);
  const autoStartAttemptedRef = useRef(false);
  const nativePrefsSyncedRef = useRef(false);

  useEffect(() => {
    nativeRevisionRef.current = nativeRevision;
  }, [nativeRevision]);

  useEffect(() => {
    saveRuntimePreferences(runtimePreferences);
    if (nativePrefsSyncedRef.current && isTauriRuntime()) {
      void saveNativeRuntimePreferences(runtimePreferences);
    }
  }, [runtimePreferences]);

  // In the Tauri runtime, runtime preferences are the authoritative source in
  // the vault (they survive reinstall and migrate with encrypted backups).
  // localStorage stays as the browser-preview fallback. We only write to the
  // vault AFTER this sync to avoid clobbering saved prefs with defaults on mount.
  useEffect(() => {
    if (!storageReady || !isTauriRuntime()) {
      nativePrefsSyncedRef.current = true;
      return;
    }
    void getNativeRuntimePreferences().then((native) => {
      if (native && Object.keys(native).length > 0) {
        setRuntimePreferences((current) => ({ ...current, ...native }));
      }
      nativePrefsSyncedRef.current = true;
    });
  }, [storageReady]);

  useEffect(() => {
    let cancelled = false;
    async function hydrateNativeStorage() {
      try {
        const [
          nativeSnapshot,
          path,
          configTemplate,
          extractionCapabilities,
          detectedOcrProviders,
          detectedLegacyOfficeProviders
        ] = await Promise.all([
          loadNativeVaultSnapshot(),
          getNativeVaultPath(),
          getClaudeDesktopConfigTemplate(),
          getNativeDocumentExtractionCapabilities().catch(() => null),
          detectNativeOcrProviderCandidates().catch(() => []),
          detectNativeLegacyOfficeProviderCandidates().catch(() => [])
        ]);
        if (cancelled) return;
        if (nativeSnapshot?.state) setState(nativeSnapshot.state);
        nativeRevisionRef.current = nativeSnapshot?.updatedAt ?? null;
        setNativeRevision(nativeSnapshot?.updatedAt ?? null);
        setNativePath(path);
        setDocumentExtractionCapabilities(extractionCapabilities);
        setOcrProviderCandidates(detectedOcrProviders);
        setLegacyOfficeProviderCandidates(detectedLegacyOfficeProviders);
        if (configTemplate) setClaudeConfig(configTemplate);
      } catch (error) {
        console.warn("Native storage unavailable", error);
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    }
    void hydrateNativeStorage();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    async function refreshLoginStatus() {
      try {
        const status = await getLoginItemStatus();
        if (!cancelled) setLoginItemStatus(status);
      } catch (error) {
        if (!cancelled) {
          setLoginItemStatus((current) =>
            current
              ? {
                  ...current,
                  lastError: formatVaultError(error, "Login item status failed")
                }
              : current
          );
        }
      }
    }
    void refreshLoginStatus();
    return () => {
      cancelled = true;
    };
  }, [storageReady]);


  useEffect(() => {
    if (!storageReady) return;
    let cancelled = false;
    saveVault(state);
    const expectedUpdatedAt = nativeRevisionRef.current;
    void saveNativeVault(state, expectedUpdatedAt)
      .then((result) => {
        if (cancelled || !result) return;
        if (result.conflict && result.currentState) {
          const mergedState = mergeVaultStates(result.currentState, state);
          nativeRevisionRef.current = result.currentUpdatedAt;
          setNativeRevision(result.currentUpdatedAt);
          setState(mergedState);
          const pendingRequest = mergedState.contextPackRequests.find((request) => requestNeedsUserAction(request));
          if (pendingRequest) {
            setActiveRequestId(pendingRequest.id);
            setActivePackId(
              mergedState.contextPacks.find((pack) => pack.requestId === pendingRequest.id)?.id ?? null
            );
          }
          setNotice("外部AI接続からの更新とローカル変更をマージしました。");
          return;
        }
        if (result.updatedAt) {
          nativeRevisionRef.current = result.updatedAt;
          setNativeRevision(result.updatedAt);
        }
      })
      .catch((error) => {
        console.warn("Native vault save failed", error);
        setNotice(
          "Vaultの保存に失敗しました。変更が反映されていない可能性があります。Settings や Audit で状態をご確認ください。"
        );
      });
    return () => {
      cancelled = true;
    };
  }, [state, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    setState((current) => purgeExpiredPassiveCaptures(current));
  }, [storageReady]);

  useEffect(() => {
    setRestorePreview(null);
    setRestoreConfirmText("");
  }, [backupPassphrase, backupText]);

  useEffect(() => {
    if (!storageReady || !nativePath) return;
    let cancelled = false;

    async function syncNativeExternalChanges() {
      try {
        const snapshot = await loadNativeVaultSnapshot();
        if (
          cancelled ||
          !snapshot?.state ||
          !snapshot.updatedAt ||
          snapshot.updatedAt === nativeRevisionRef.current
        ) {
          return;
        }

        nativeRevisionRef.current = snapshot.updatedAt;
        setNativeRevision(snapshot.updatedAt);
        setState(snapshot.state);

        const pendingRequest = snapshot.state.contextPackRequests.find((request) => requestNeedsUserAction(request));
        if (pendingRequest) {
          setActiveRequestId(pendingRequest.id);
          setActivePackId(
            snapshot.state.contextPacks.find((pack) => pack.requestId === pendingRequest.id)?.id ?? null
          );
          setNotice(`${pendingRequest.clientName}からContext Requestを受信しました。Requestsで確認できます。`);
        } else {
          setNotice("外部AI接続からのVault更新を同期しました。");
        }
      } catch (error) {
        console.warn("Native vault external sync failed", error);
      }
    }

    const interval = window.setInterval(syncNativeExternalChanges, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [nativePath, storageReady]);

  useEffect(() => {
    if (!storageReady || !nativePath) {
      setSearchMode("browser_fallback");
      setNativeSearchResults([]);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setSearchMode("loading");
    setSearchError(null);
    async function runNativeSearch() {
      try {
        const results = await searchNativeFacts({
          query: searchQuery,
          domain: domainFilter,
          sensitivity: sensitivityFilter,
          limit: 80
        });
        if (cancelled) return;
        if (!results) {
          setSearchMode("browser_fallback");
          setNativeSearchResults([]);
          return;
        }
        setNativeSearchResults(results);
        setSearchMode("native_fts");
      } catch (error) {
        if (cancelled) return;
        setSearchError(formatVaultError(error, "Native search failed"));
        setSearchMode("browser_fallback");
        setNativeSearchResults([]);
      }
    }
    void runNativeSearch();
    return () => {
      cancelled = true;
    };
  }, [
    domainFilter,
    nativePath,
    nativeRevision,
    searchQuery,
    sensitivityFilter,
    storageReady
  ]);


  const activeCandidates = useMemo(
    () =>
      state.candidates.filter((candidate) =>
        ["new", "needs_user_detail", "blocked_sensitive"].includes(candidate.status)
      ),
    [state.candidates]
  );
  const activeFacts = useMemo(
    () => state.facts.filter((fact) => fact.status === "active"),
    [state.facts]
  );
  const reviewFacts = useMemo(
    () => state.facts.filter((fact) => fact.status === "needs_review"),
    [state.facts]
  );
  const supersededFacts = useMemo(
    () =>
      state.facts
        .filter(
          (fact) =>
            fact.status === "superseded" &&
            (domainFilter === "all" || fact.domain === domainFilter) &&
            (sensitivityFilter === "all" || fact.sensitivity === sensitivityFilter) &&
            (!searchQuery.trim() || fact.factText.toLowerCase().includes(searchQuery.trim().toLowerCase()))
        )
        .slice(0, 25),
    [domainFilter, searchQuery, sensitivityFilter, state.facts]
  );
  const currentPack = useMemo(
    () => state.contextPacks.find((pack) => pack.id === activePackId) ?? null,
    [activePackId, state.contextPacks]
  );
  const currentRequest = useMemo(
    () => state.contextPackRequests.find((request) => request.id === activeRequestId) ?? null,
    [activeRequestId, state.contextPackRequests]
  );
  const localSearchResults = useMemo(
    () =>
      searchFacts(state, searchQuery, {
        domain: domainFilter,
        sensitivity: sensitivityFilter
      }),
    [domainFilter, searchQuery, sensitivityFilter, state]
  );
  const searchResults = nativePath && searchMode === "native_fts"
    ? nativeSearchResults
    : localSearchResults;
  const configuredOcrCommand = runtimePreferences.ocrCommand.trim();
  const configuredOcrArgs = runtimePreferences.ocrArgs.trim();
  const configuredOcrTimeoutSeconds = normalizedOcrTimeout(runtimePreferences.ocrTimeoutSeconds);
  const configuredLegacyOfficeCommand = runtimePreferences.legacyOfficeCommand.trim();
  const configuredLegacyOfficeArgs = runtimePreferences.legacyOfficeArgs.trim();
  const configuredLegacyOfficeTimeoutSeconds = normalizedOcrTimeout(runtimePreferences.legacyOfficeTimeoutSeconds, 60);
  const runtimeOcrAvailable = Boolean(configuredOcrCommand);
  const runtimeLegacyOfficeAvailable = Boolean(configuredLegacyOfficeCommand);
  const ocrExtractionAvailable = Boolean(documentExtractionCapabilities?.ocrExtraction || runtimeOcrAvailable);
  const legacyOfficeConversionAvailable = Boolean(
    documentExtractionCapabilities?.legacyOfficeConversion || runtimeLegacyOfficeAvailable
  );
  const ocrProviderLabel = runtimeOcrAvailable
    ? ocrProviderLabelFromCommand(configuredOcrCommand)
    : documentExtractionCapabilities?.ocrProviderLabel ?? null;
  const legacyOfficeProviderLabel = runtimeLegacyOfficeAvailable
    ? ocrProviderLabelFromCommand(configuredLegacyOfficeCommand)
    : documentExtractionCapabilities?.legacyOfficeProviderLabel ?? null;
  const sourceAccept = sourceAcceptForCapabilities(ocrExtractionAvailable, legacyOfficeConversionAvailable);
  const sourceLabel = sourceLabelForCapabilities(ocrExtractionAvailable, legacyOfficeConversionAvailable);

  function apply(next: VaultState, message?: string) {
    setState(next);
    if (message) setNotice(message);
  }
  async function addManualSource() {
    if (!manualBody.trim()) {
      setNotice("メモ本文を入力してください。");
      return;
    }
    const addStatus = await addSourceThroughCore(
      {
        kind: "manual_note",
        origin: "manual_entry",
        title: manualTitle || "Manual note",
        body: manualBody
      },
      "Sourceを保存し、Memory Inboxに記憶を追加しました。"
    );
    if (addStatus === "unavailable") {
      const next = addSourceWithCandidates(state, {
        kind: "manual_note",
        origin: "manual_entry",
        title: manualTitle || "Manual note",
        body: manualBody
      });
      apply(next, "Sourceを保存し、Memory Inboxに記憶を追加しました。");
      setView("sources");
    }
    if (addStatus === "failed") return;
    setManualTitle("");
    setManualBody("");
  }

  async function handleFileUpload(file: File) {
    const support = describeSourceFile(
      file,
      Boolean(nativePath),
      ocrExtractionAvailable,
      legacyOfficeConversionAvailable
    );
    if (!support.supported) {
      if (
        nativePath &&
        (support.reason === "ocr_required" ||
          support.reason === "legacy_office" ||
          support.reason === "native_required")
      ) {
        // Graceful fallback: register the file as a needs_runtime source so the
        // user keeps a record and can re-extract after configuring the runtime,
        // instead of a hard rejection.
        try {
          const added = await addNativeSourcePendingRuntime({
            kind: "document",
            origin: "user_upload",
            title: file.name
          });
          if (added) {
            nativeRevisionRef.current = added.updatedAt;
            setNativeRevision(added.updatedAt);
            setState(added.state);
            setNotice(
              `${file.name} を保留中Sourceとして保存しました（抽出ランタイム未設定）。Settings で OCR / Office 変換を設定すると再処理できます。`
            );
            setView("sources");
            return;
          }
        } catch (error) {
          setNotice(formatVaultError(error, "保留中Sourceの保存に失敗しました。"));
        }
      }
      setUploadFeedback(unsupportedFileFeedback(file, support.reason));
      return;
    }

    let text = "";
    let extractionDetail = "";
    if (support.extraction === "browser_text") {
      try {
        text = await file.text();
      } catch {
        setUploadFeedback({
          tone: "attention",
          title: "ファイルを読めませんでした",
          body: "ローカルで本文を開けませんでした。内容をテキストとしてコピーできる場合は、Manual sourceに貼り付けてください。"
        });
        return;
      }

      if (!looksLikeReadableText(text)) {
        setUploadFeedback({
          tone: "attention",
          title: "テキストとして読めませんでした",
          body: "このファイルはテキスト形式として指定されていますが、本文が読めませんでした。誤った記憶を作らないためSource化していません。"
        });
        return;
      }
    } else {
      try {
        const extracted = await extractNativeDocumentText({
          fileName: file.name,
          mimeType: file.type,
          contentBase64: await fileToBase64(file),
          ocrCommand: runtimeOcrAvailable ? configuredOcrCommand : null,
          ocrArgs: runtimeOcrAvailable ? configuredOcrArgs : null,
          ocrTimeoutSeconds: runtimeOcrAvailable ? configuredOcrTimeoutSeconds : null,
          legacyOfficeCommand: runtimeLegacyOfficeAvailable ? configuredLegacyOfficeCommand : null,
          legacyOfficeArgs: runtimeLegacyOfficeAvailable ? configuredLegacyOfficeArgs : null,
          legacyOfficeTimeoutSeconds: runtimeLegacyOfficeAvailable ? configuredLegacyOfficeTimeoutSeconds : null
        });
        if (!extracted) {
          setUploadFeedback(unsupportedFileFeedback(file, "native_required"));
          return;
        }
        text = extracted.text;
        extractionDetail = ` ${documentExtractionLabel(extracted.detectedKind)}としてローカル抽出しました。${extracted.warnings.join(" ")}`;
      } catch (error) {
        setUploadFeedback({
          tone: "attention",
          title: "文書を抽出できませんでした",
          body:
            error instanceof Error
              ? error.message
              : "ローカル抽出で本文を取り出せませんでした。内容をテキスト化できる場合はManual sourceに貼り付けてください。"
        });
        return;
      }
    }

    const addStatus = await addSourceThroughCore(
      {
        kind: "document",
        origin: "user_upload",
        title: file.name,
        body: text
      },
      `${file.name} をSourceとして保存し、Memory Inboxに記憶を追加しました。${extractionDetail}`
    );
    if (addStatus === "unavailable") {
      const next = addSourceWithCandidates(state, {
        kind: "document",
        origin: "user_upload",
        title: file.name,
        body: text
      });
      apply(next, `${file.name} をSourceとして保存し、Memory Inboxに記憶を追加しました。${extractionDetail}`);
      setView("sources");
    }
    if (addStatus !== "failed") setUploadFeedback(null);
  }

  async function addSourceThroughCore(
    input: {
      kind: SourceKind;
      origin: SourceOrigin;
      title: string;
      body: string;
    },
    message: string
  ): Promise<"saved" | "unavailable" | "failed"> {
    if (!nativePath) return "unavailable";
    try {
      const added = await addNativeSourceWithCandidates(input);
      if (!added) return "unavailable";
      nativeRevisionRef.current = added.updatedAt;
      setNativeRevision(added.updatedAt);
      setState(added.state);
      setNotice(
        `${message} ${added.candidateIds.length}件の記憶が作成されました。承認されるまでAIには使われません。`
      );
      setView("sources");
      return "saved";
    } catch (error) {
      setNotice(formatVaultError(error, "Vault CoreでSourceを保存できませんでした。"));
      return "failed";
    }
  }

  async function changeSourceLifecycle(sourceId: string, action: SourceLifecycleAction) {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) {
      setNotice("Sourceが見つかりませんでした。");
      return;
    }
    if (nativePath) {
      try {
        const updated = await updateNativeSourceLifecycle({ sourceId, action });
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(sourceLifecycleNotice(updated.action, updated.affectedFactCount, updated.invalidatedPackCount));
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでSourceを更新できませんでした。"));
        return;
      }
    }
    apply(
      updateSourceLifecycle(state, sourceId, action),
      sourceLifecycleNotice(action, linkedFactCount(state, sourceId), 0)
    );
  }

  async function purgePassiveCaptureEvent(eventId: string) {
    const event = state.passiveCaptureEvents.find((item) => item.id === eventId);
    const sourceId = event ? passiveCaptureSourceId(event) : null;
    const source = sourceId ? state.sources.find((item) => item.id === sourceId) : null;
    if (!event || !source) {
      setNotice("Capture履歴に紐づくSourceが見つかりませんでした。");
      return;
    }
    if (source.deletionState === "purged") {
      setNotice("このCapture本文はすでに消去済みです。");
      return;
    }
    await changeSourceLifecycle(source.id, "purge_body");
  }

  async function purgeAllPassiveCaptures() {
    const sourceIds = passiveCaptureSourceIds(state)
      .filter((sourceId) => state.sources.find((source) => source.id === sourceId)?.deletionState !== "purged");
    if (sourceIds.length === 0) {
      setConfirmAllCapturePurge(false);
      setNotice("消去できるCapture本文はありません。");
      return;
    }
    if (!confirmAllCapturePurge) {
      setConfirmAllCapturePurge(true);
      setNotice(`${sourceIds.length}件のCapture本文を消去する前に、画面の影響表示を確認してください。`);
      return;
    }

    if (nativePath) {
      try {
        let latestState: VaultState | null = null;
        let latestRevision: string | null = null;
        for (const sourceId of sourceIds) {
          const updated = await updateNativeSourceLifecycle({ sourceId, action: "purge_body" });
          if (updated) {
            latestState = updated.state;
            latestRevision = updated.updatedAt;
          }
        }
        if (latestState && latestRevision) {
          nativeRevisionRef.current = latestRevision;
          setNativeRevision(latestRevision);
          setState(latestState);
          setNotice(`${sourceIds.length}件のCapture本文を消去しました。`);
        }
        setConfirmAllCapturePurge(false);
        return;
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでCapture本文を消去できませんでした。"));
        return;
      }
    }

    const next = sourceIds.reduce(
      (current, sourceId) => updateSourceLifecycle(current, sourceId, "purge_body"),
      state
    );
    apply(next, `${sourceIds.length}件のCapture本文を消去しました。`);
    setConfirmAllCapturePurge(false);
  }

  async function editSourceMetadata(sourceId: string, input: SourceMetadataUpdate): Promise<boolean> {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) {
      setNotice("Sourceが見つかりませんでした。");
      return false;
    }
    if (!input.title.trim()) {
      setNotice("Sourceタイトルを入力してください。");
      return false;
    }
    if (nativePath) {
      try {
        const updated = await updateNativeSourceMetadata(sourceId, input);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(sourceMetadataNotice(updated.invalidatedPackCount));
          return true;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでSourceを保存できませんでした。"));
        return false;
      }
    }
    apply(
      updateSourceMetadata(state, sourceId, input),
      sourceMetadataNotice(activeSourcePackCount(state, sourceId))
    );
    return true;
  }

  async function editSourceBody(sourceId: string, input: SourceBodyUpdate): Promise<boolean> {
    const source = state.sources.find((item) => item.id === sourceId);
    if (!source) {
      setNotice("Sourceが見つかりませんでした。");
      return false;
    }
    if (source.deletionState !== "active") {
      setNotice("停止または消去されたSource本文は編集できません。先に復元してください。");
      return false;
    }
    if (!input.body.trim()) {
      setNotice("Source本文を入力してください。");
      return false;
    }
    if (nativePath) {
      try {
        const updated = await updateNativeSourceBody(sourceId, input);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(sourceBodyNotice(
            updated.candidateIds.length,
            updated.affectedFactCount,
            updated.invalidatedPackCount
          ));
          return true;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでSource本文を保存できませんでした。"));
        return false;
      }
    }
    const affectedFactCount = activeLinkedFactCount(state, sourceId);
    const next = updateSourceBody(state, sourceId, input);
    apply(next, sourceBodyNotice(
      Math.max(0, next.candidates.length - state.candidates.length),
      affectedFactCount,
      activeSourcePackCount(state, sourceId)
    ));
    return true;
  }

  async function changeFactLifecycle(factId: string, action: FactLifecycleAction) {
    const fact = state.facts.find((item) => item.id === factId);
    if (!fact) {
      setNotice("記憶が見つかりませんでした。");
      return;
    }
    if (nativePath) {
      try {
        const updated = await updateNativeFactLifecycle({ factId, action });
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(factLifecycleNotice(updated.action, updated.invalidatedPackCount));
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでFactを更新できませんでした。"));
        return;
      }
    }
    apply(
      updateFactLifecycle(state, factId, action),
      factLifecycleNotice(action, activeFactPackCount(state, factId))
    );
  }

  async function editFactMetadata(factId: string, input: FactMetadataUpdate): Promise<boolean> {
    const fact = state.facts.find((item) => item.id === factId);
    if (!fact) {
      setNotice("記憶が見つかりませんでした。");
      return false;
    }
    if (!input.factText.trim()) {
      setNotice("記憶の本文を入力してください。");
      return false;
    }
    if (input.sensitivity === "secret_never_send") {
      setNotice("Secretは記憶として保存できません。Sourceまたは記憶を削除してください。");
      return false;
    }
    if (nativePath) {
      try {
        const updated = await updateNativeFactMetadata(factId, input);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(factMetadataNotice(updated.invalidatedPackCount));
          return true;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでFactを保存できませんでした。"));
        return false;
      }
    }
    apply(
      updateFactMetadata(state, factId, input),
      factMetadataNotice(activeFactPackCount(state, factId))
    );
    return true;
  }

  async function approve(candidate: MemoryCandidate) {
    const edited = candidateEdits[candidate.id];
    const supersedeFactIds = candidateSupersedes[candidate.id] ?? [];
    if (nativePath) {
      try {
        const reviewed = await approveNativeCandidate({
          candidateId: candidate.id,
          editedText: edited,
          supersedeFactIds
        });
        if (reviewed) {
          nativeRevisionRef.current = reviewed.updatedAt;
          setNativeRevision(reviewed.updatedAt);
          setState(reviewed.state);
          setCandidateEdits((current) => {
            const next = { ...current };
            delete next[candidate.id];
            return next;
          });
          setCandidateSupersedes((current) => {
            const next = { ...current };
            delete next[candidate.id];
            return next;
          });
          setNotice(candidateApprovalNotice(reviewed.supersededFactIds.length, reviewed.invalidatedPackCount));
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault Coreで候補を承認できませんでした。"));
        return;
      }
    }
    if (candidate.sourceIds.some((sourceId) => state.sources.find((source) => source.id === sourceId)?.deletionState !== "active")) {
      setNotice("削除または消去されたSource由来の記憶は承認できません。Sourceを復元するか、新しいSourceとして追加してください。");
      return;
    }
    const invalidatedPackCount = packsForFacts(state, supersedeFactIds).length;
    const next = approveCandidate(state, candidate.id, { editedText: edited, supersedeFactIds });
    setCandidateSupersedes((current) => {
      const nextSelections = { ...current };
      delete nextSelections[candidate.id];
      return nextSelections;
    });
    apply(next, candidateApprovalNotice(supersedeFactIds.length, invalidatedPackCount));
  }

  async function reviewCandidateStatus(
    candidate: MemoryCandidate,
    status: CandidateStatus,
    message: string
  ) {
    if (nativePath) {
      try {
        const reviewed = await updateNativeCandidateStatus({
          candidateId: candidate.id,
          status
        });
        if (reviewed) {
          nativeRevisionRef.current = reviewed.updatedAt;
          setNativeRevision(reviewed.updatedAt);
          setState(reviewed.state);
          setNotice(message);
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault Coreで候補を更新できませんでした。"));
        return;
      }
    }
    apply(updateCandidateStatus(state, candidate.id, status), message);
  }

  async function buildPack() {
    if (!question.trim()) {
      setNotice("質問を入力してください。");
      return;
    }
    const client = state.connectorSessions.find((session) => session.id === requestClientId);
    if (nativePath) {
      try {
        const built = await createNativeContextPackRequest({
          clientId: requestClientId,
          clientName: client?.clientName ?? "Unknown AI",
          taskText: question,
          purpose: "普段使うAIへの回答文脈",
          approvalMode: "explicit_sensitive"
        });
        if (built) {
          nativeRevisionRef.current = built.updatedAt;
          setNativeRevision(built.updatedAt);
          setState(built.state);
          setNotice("Vault CoreでContext Requestを受け取り、短命のAIに渡す内容（記憶）を生成しました。");
          setActiveRequestId(built.requestId);
          setActivePackId(built.packId);
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでContext Packを生成できませんでした。"));
        return;
      }
    }
    const requested = createContextPackRequest(state, {
      clientId: requestClientId,
      clientName: client?.clientName ?? "Unknown AI",
      taskText: question,
      purpose: "普段使うAIへの回答文脈",
      approvalMode: "explicit_sensitive"
    });
    const built = buildContextPackForRequest(requested.state, requested.request.id);
    apply(built.state, "Context Requestを受け取り、短命のAIに渡す内容（記憶）を生成しました。");
    setActiveRequestId(requested.request.id);
    setActivePackId(built.pack?.id ?? null);
  }

  function generateAnswer(pack: ContextPack) {
    const confirmedPack =
      pack.confirmationStatus === "pending_user_confirmation"
        ? { ...pack, confirmationStatus: "confirmed" as const, confirmedAt: new Date().toISOString() }
        : pack;
    const answer = generateLocalAnswer(confirmedPack);
    const next = attachLocalAnswer(state, pack.id, answer);
    apply(
      next,
      pack.confirmationStatus === "pending_user_confirmation"
        ? "ローカル回答を生成しました。外部AIへ返すには別途承認してください。"
        : "ローカル回答を生成しました。"
    );
  }

  async function changePackItemVisibility(pack: ContextPack, factId: string, included: boolean) {
    const verb = included ? "AIに渡す内容（記憶）へ戻しました。" : "このAIには渡さないようAIに渡す内容（記憶）から外しました。";
    if (nativePath) {
      try {
        const updated = await updateNativeContextPackItemVisibility({
          packId: pack.id,
          factId,
          included
        });
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setActivePackId(updated.packId ?? pack.id);
          if (updated.requestId) setActiveRequestId(updated.requestId);
          setNotice(verb);
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでContext Packを更新できませんでした。"));
        return;
      }
    }
    apply(updateContextPackItemVisibility(state, pack.id, factId, included), verb);
  }

  async function approvePackForAi(pack: ContextPack) {
    const request = pack.requestId
      ? state.contextPackRequests.find((item) => item.id === pack.requestId)
      : null;
    if (pack.confirmationStatus === "confirmed" && request?.status === "fulfilled") {
      if (!canSendContextPackToAi(state, pack)) {
        setNotice("このAIに渡す内容（記憶）は現在のAI接続ポリシーでは送信できません。新しくAIに渡す内容（記憶）を作成してください。");
        return;
      }
      setNotice("このAIに渡す内容（記憶）はすでにAIへ返せる状態です。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
      return;
    }
    if (nativePath) {
      try {
        const updated = await confirmNativeContextPack(pack.id);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setActivePackId(updated.packId ?? pack.id);
          if (updated.requestId) setActiveRequestId(updated.requestId);
          setNotice("AIに渡す内容（記憶）を承認しました。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでContext Packを承認できませんでした。"));
        return;
      }
    }
    const confirmedState = confirmContextPack(state, pack.id);
    const confirmedPack = confirmedState.contextPacks.find((item) => item.id === pack.id);
    if (!confirmedPack || !canSendContextPackToAi(confirmedState, confirmedPack)) {
      apply(
        confirmedState,
        "このAIに渡す内容（記憶）は現在のAI接続ポリシーでは承認できません。新しくAIに渡す内容（記憶）を作成してください。"
      );
      return;
    }
    apply(confirmedState, "AIに渡す内容（記憶）を承認しました。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
  }

  async function copyPackForAi(pack: ContextPack) {
    const request = pack.requestId
      ? state.contextPackRequests.find((item) => item.id === pack.requestId)
      : null;
    const shouldConfirm = pack.confirmationStatus !== "confirmed" || request?.status !== "fulfilled";
    if (!shouldConfirm && !canSendContextPackToAi(state, pack)) {
      setNotice("このAIに渡す内容（記憶）は現在のAI接続ポリシーではコピーできません。新しくAIに渡す内容（記憶）を作成してください。");
      return;
    }
    let payloadPack = shouldConfirm
      ? { ...pack, confirmationStatus: "confirmed" as const, confirmedAt: new Date().toISOString() }
      : pack;
    if (shouldConfirm) {
      if (nativePath) {
        try {
          const updated = await confirmNativeContextPack(pack.id);
          if (updated) {
            nativeRevisionRef.current = updated.updatedAt;
            setNativeRevision(updated.updatedAt);
            setState(updated.state);
            setActivePackId(updated.packId ?? pack.id);
            if (updated.requestId) setActiveRequestId(updated.requestId);
            payloadPack = updated.state.contextPacks.find((item) => item.id === pack.id) ?? payloadPack;
            if (!canSendContextPackToAi(updated.state, payloadPack)) {
              setNotice("このAIに渡す内容（記憶）は現在のAI接続ポリシーではコピーできません。新しくAIに渡す内容（記憶）を作成してください。");
              return;
            }
          }
        } catch (error) {
          setNotice(formatVaultError(error, "Vault CoreでContext Packを承認できませんでした。"));
          return;
        }
      } else {
        const confirmedState = confirmContextPack(state, pack.id);
        const confirmedPack = confirmedState.contextPacks.find((item) => item.id === pack.id);
        if (!confirmedPack || !canSendContextPackToAi(confirmedState, confirmedPack)) {
          setState(confirmedState);
          setNotice("このAIに渡す内容（記憶）は現在のAI接続ポリシーではコピーできません。新しくAIに渡す内容（記憶）を作成してください。");
          return;
        }
        setState(confirmedState);
        payloadPack = confirmedPack;
      }
    }
    const aiPayload = makeAiContextPackPayload(payloadPack);
    const promptText = [
      "## Life Context",
      "",
      `Task: ${aiPayload.taskText}`,
      "",
      "### Context (approved by the user)",
      "",
      ...aiPayload.items.map(
        (item, i) => `${i + 1}. ${item.itemText}${item.sourceTitles?.length ? ` (Source: ${item.sourceTitles.join(", ")})` : ""}`
      ),
      "",
      aiPayload.warnings.length
        ? `### 注意\n${aiPayload.warnings.map((w) => `- ${w.message}`).join("\n")}\n`
      : "",
      "上記の文脈を踏まえて回答してください。",
      ""
    ].filter(Boolean).join("\n");
    const payloadText = promptText;
    const copied = await copyText(
      payloadText,
      shouldConfirm
        ? "AIに渡す内容（記憶）を承認し、ChatGPT/Claude向けプロンプトをコピーしました。そのまま貼り付けてください。"
        : "ChatGPT/Claude向けプロンプトをコピーしました。そのまま貼り付けてください。"
    );
    if (copied) {
      setManualCopyPayload(null);
      setState((current) =>
        recordContextPackDelivery(current, payloadPack.id, {
          channel: "clipboard_copy",
          status: "copied"
        })
      );
    } else {
      setManualCopyPayload({
        packId: payloadPack.id,
        payloadText,
        createdAt: new Date().toISOString()
      });
      setNotice("Clipboardに書き込めませんでした。下の手動コピー欄から選択してコピーしてください。");
    }
  }

  function recordManualCopyDelivery(packId: string) {
    const pack = state.contextPacks.find((item) => item.id === packId);
    if (!pack || !canSendContextPackToAi(state, pack)) {
      setManualCopyPayload(null);
      setNotice("このAIに渡す内容（記憶）は現在のAI接続ポリシーでは記録できません。新しくAIに渡す内容（記憶）を作成してください。");
      return;
    }
    setState((current) =>
      recordContextPackDelivery(current, packId, {
        channel: "clipboard_copy",
        status: "copied"
      })
    );
    setManualCopyPayload(null);
    setNotice("手動コピー済みとしてAuditに記録しました。");
  }

  async function denyActiveRequest() {
    if (!activeRequestId) return;
    if (nativePath) {
      try {
        const updated = await denyNativeContextPackRequest(activeRequestId);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setActivePackId(updated.packId);
          setActiveRequestId(updated.requestId ?? activeRequestId);
          setNotice("このContext Requestを拒否しました。");
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでContext Requestを拒否できませんでした。"));
        return;
      }
    }
    apply(denyContextPackRequest(state, activeRequestId), "このContext Requestを拒否しました。");
  }

  function updatePolicy(
    clientId: string,
    settings: Partial<Pick<AccessPolicy, "sensitivityCeiling" | "requiresApprovalAbove" | "passiveCaptureAllowed" | "domainAllowlist">>
  ) {
    void updatePolicyThroughCore(clientId, settings);
  }

  async function updatePolicyThroughCore(
    clientId: string,
    settings: Partial<Pick<AccessPolicy, "sensitivityCeiling" | "requiresApprovalAbove" | "passiveCaptureAllowed" | "domainAllowlist">>
  ) {
    if (nativePath) {
      try {
        const updated = await updateNativeAccessPolicy({
          clientId,
          ...settings
        });
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice("AI接続ポリシーをVault Coreで保存しました。");
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Vault CoreでAI接続ポリシーを保存できませんでした。"));
        return;
      }
    }
    apply(updateAccessPolicy(state, clientId, settings), "AI接続ポリシーを更新しました。");
  }

  async function setStandingDeliveryThroughCore(clientId: string, enabled: boolean) {
    if (nativePath) {
      try {
        const updated = await setNativeConnectionStandingDelivery({ clientId, enabled });
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice(enabled ? "Standing deliveryを有効にしました。" : "Standing deliveryを無効にしました。");
          return;
        }
      } catch (error) {
        setNotice(formatVaultError(error, "Standing delivery設定を保存できませんでした。"));
        return;
      }
    }
    // M1: use functional updater so this state write is not clobbered if
    // approvePackForAi (called synchronously right after setStandingDelivery)
    // also applies a state update from the same stale closure on this path.
    setState((prev) => updateAccessPolicy(prev, clientId, { standingDeliveryEnabled: enabled }));
    setNotice(enabled ? "Standing deliveryを有効にしました。" : "Standing deliveryを無効にしました。");
  }

  function setStandingDelivery(clientId: string, enabled: boolean) {
    void setStandingDeliveryThroughCore(clientId, enabled);
  }

  async function copyText(value: string, message: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
      return true;
    } catch {
      setNotice("Clipboardに書き込めませんでした。表示された内容を手動でコピーしてください。");
      return false;
    }
  }

  async function exportBackup() {
    try {
      const payload = isTauriRuntime()
        ? (await exportNativeEncryptedBackup(backupPassphrase)) ??
          (await exportEncryptedBackup(state, backupPassphrase))
        : await exportEncryptedBackup(state, backupPassphrase);
      const blob = new Blob([payload], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = href;
      link.download = "life-context-vault-backup.json";
      link.click();
      URL.revokeObjectURL(href);
      setBackupText(payload);
      setNotice("暗号化バックアップを書き出しました。");
    } catch (error) {
      setNotice(formatVaultError(error, "バックアップに失敗しました。"));
    }
  }

  async function previewRestoreBackup() {
    try {
      const restored = isTauriRuntime()
        ? (await importNativeEncryptedBackup(backupText, backupPassphrase)) ??
          (await importEncryptedBackup(backupText, backupPassphrase))
        : await importEncryptedBackup(backupText, backupPassphrase);
      setRestorePreview(makeRestorePreview(restored, state));
      setRestoreConfirmText("");
      setNotice("バックアップを読み取りました。移行内容と上書き範囲を確認し、復元する場合はRESTOREと入力してください。");
    } catch (error) {
      setRestorePreview(null);
      setRestoreConfirmText("");
      setNotice(formatVaultError(error, "バックアップの読み取りに失敗しました。"));
    }
  }

  async function restoreBackup() {
    if (!restorePreview) {
      setNotice("まず復元プレビューを作成してください。");
      return;
    }
    if (restoreConfirmText !== "RESTORE") {
      setNotice("復元するには確認欄へRESTOREと入力してください。");
      return;
    }
    try {
      const restored = isTauriRuntime()
        ? (await importNativeEncryptedBackup(backupText, backupPassphrase)) ??
          (await importEncryptedBackup(backupText, backupPassphrase))
        : await importEncryptedBackup(backupText, backupPassphrase);
      apply(restored, "バックアップを復元しました。");
      setActivePackId(null);
      setActiveRequestId(null);
      setRestorePreview(null);
      setRestoreConfirmText("");
    } catch (error) {
      setNotice(formatVaultError(error, "復元に失敗しました。"));
    }
  }

  async function refreshFromNative() {
    try {
      const nativeSnapshot = await loadNativeVaultSnapshot();
      if (!nativeSnapshot?.state) {
        setNotice("Native Vaultはまだ見つかりません。");
        return;
      }
      setState(nativeSnapshot.state);
      nativeRevisionRef.current = nativeSnapshot.updatedAt;
      setNativeRevision(nativeSnapshot.updatedAt);
      setNotice("Native Vaultから最新状態を読み込みました。");
    } catch (error) {
      setNotice(formatVaultError(error, "Native Vaultの再読み込みに失敗しました。"));
    }
  }

  function updateRuntimePreference(next: Partial<RuntimePreferences>) {
    setRuntimePreferences((current) => {
      const updated = {
        ...current,
        ...next
      };
      saveRuntimePreferences(updated);
      return updated;
    });
  }

  async function setDeliveryNotificationsEnabled(enabled: boolean) {
    await setNativeDeliveryNotificationsEnabled(enabled);
    updateRuntimePreference({ deliveryNotificationsEnabled: enabled });
    if (enabled) {
      try {
        const { requestPermission } = await import(
          "@tauri-apps/plugin-notification"
        );
        await requestPermission();
      } catch {
        // permission request best-effort; setting is already persisted
      }
    }
  }

  async function refreshLoginItem() {
    try {
      const status = await getLoginItemStatus();
      setLoginItemStatus(status);
      setNotice(status ? "Login Itemの状態を更新しました。" : "Desktop appでのみLogin Itemを管理できます。");
    } catch (error) {
      setNotice(formatVaultError(error, "Login Itemの状態確認に失敗しました。"));
    }
  }

  async function enableLoginItem() {
    setLoginItemBusy(true);
    try {
      const status = await installLoginItem();
      setLoginItemStatus(status);
      setNotice(
        status?.enabled
          ? "ログイン時にLife Context Vaultが起動するようにしました。"
          : "Login Itemを有効にできませんでした。"
      );
    } catch (error) {
      setNotice(formatVaultError(error, "Login Itemの有効化に失敗しました。"));
      void getLoginItemStatus().then(setLoginItemStatus).catch(() => undefined);
    } finally {
      setLoginItemBusy(false);
    }
  }

  async function disableLoginItem() {
    setLoginItemBusy(true);
    try {
      const status = await uninstallLoginItem();
      setLoginItemStatus(status);
      setNotice("Login Itemを無効にしました。");
    } catch (error) {
      setNotice(formatVaultError(error, "Login Itemの無効化に失敗しました。"));
      void getLoginItemStatus().then(setLoginItemStatus).catch(() => undefined);
    } finally {
      setLoginItemBusy(false);
    }
  }

  async function installClaudeConfig() {
    setClaudeInstallBusy(true);
    setClaudeInstallResult(null);
    try {
      const result = await installClaudeDesktopConfig();
      setClaudeInstallResult(result);
      if (!result) {
        setNotice("Desktop appでのみClaude Desktop設定をインストールできます。");
      } else if (result.alreadyConfigured) {
        const base = "Claude Desktop設定はすでに最新です。";
        setNotice(result.warning ? `${base} ／ ${result.warning}` : base);
      } else {
        const base = "Claude Desktop設定へLife Context Vaultを追加しました。Claude Desktopを再起動してください。";
        setNotice(result.warning ? `${base} ／ ${result.warning}` : base);
      }
    } catch (error) {
      const errStr = formatVaultError(error, "");
      const isSidecarMissing = errStr.includes("lcv-mcp");
      const msg = isSidecarMissing
        ? "lcv-mcp バイナリが見つかりません。npm run sidecars:prepare を実行するか、バンドル版アプリをお使いください。"
        : formatVaultError(error, "インストールに失敗しました。");
      setNotice(msg);
    } finally {
      setClaudeInstallBusy(false);
    }
  }

  function clearVault() {
    if (clearConfirmText !== "CLEAR") {
      setNotice("Vaultをクリアするには確認欄へCLEARと入力してください。");
      return;
    }
    apply(createEmptyVault(), "Vaultをクリアしました。");
    setActivePackId(null);
    setActiveRequestId(null);
    setClearConfirmText("");
  }

  function seedDemo() {
    apply(makeDemoVault(), "デモデータを投入しました。");
    setView("home");
  }

  if (showGallery) {
    return <QVGallery onClose={() => setShowGallery(false)} />;
  }

  return (
    <div className="app-shell">
      <Rail
        view={view}
        setView={setView}
        lang={lang}
        setLang={setLang}
        candidateCount={activeCandidates.length}
        requestCount={state.contextPackRequests.filter((request) => requestNeedsUserAction(request)).length}
        reviewFactCount={reviewFacts.length}
        hasActiveConnection={state.connectorSessions.some((s) => s.status === "connected")}
      />

      <main className="workspace">
        <header className="topbar">
          {!VIEWS_WITH_OWN_HEADER.has(view) && (
            <div>
              <p className="eyebrow">User-owned life context</p>
              <h2>{titleForView(view)}</h2>
            </div>
          )}
          <div className="topbar-actions">
            {nativePath && (
              <button className="secondary-button" onClick={refreshFromNative} type="button">
                <RefreshCw size={16} />
                Sync
              </button>
            )}
            {notice && (
              <div className="notice" role="status" aria-live="polite">
                <span>{notice}</span>
                <button aria-label="通知を閉じる" onClick={() => setNotice("")} type="button">
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        </header>

        {view === "home" && (
          <HomeTimeline
            state={state}
            goSources={() => setView("sources")}
            goConnections={() => setView("connections")}
            seedDemo={seedDemo}
            onApprovePending={(packId) => {
              const pack = state.contextPacks.find((p) => p.id === packId);
              if (pack) void approvePackForAi(pack);
            }}
            onApproveStanding={(packId, clientId) => {
              setStandingDelivery(clientId, true);
              const pack = state.contextPacks.find((p) => p.id === packId);
              if (pack) void approvePackForAi(pack);
            }}
            onRevoke={(packId) => {
              const pack = state.contextPacks.find((p) => p.id === packId);
              if (!pack) return;
              const ok = window.confirm(
                "この記憶を今後どのAIにも渡しません。よろしいですか？"
              );
              if (!ok) return;
              const next = pack.items.reduce(
                (s, item) => updateFactLifecycle(s, item.factId, "hide"),
                state
              );
              apply(next, "記憶を非表示にしました。今後どのAIにも渡しません。");
            }}
          />
        )}
        {view === "sources" && (
          <IngestView
            /* ── Candidate review (formerly InboxView) ── */
            candidates={activeCandidates}
            facts={activeFacts}
            edits={candidateEdits}
            supersedes={candidateSupersedes}
            setEdit={(id, value) => setCandidateEdits((prev) => ({ ...prev, [id]: value }))}
            toggleSupersede={(candidateId, factId) =>
              setCandidateSupersedes((current) => ({
                ...current,
                [candidateId]: toggleSelectedId(current[candidateId] ?? [], factId)
              }))
            }
            approve={approve}
            reject={(candidate) => void reviewCandidateStatus(candidate, "rejected", "記憶を却下しました。")}
            archive={(candidate) => void reviewCandidateStatus(candidate, "archived", "記憶をあとでに移しました。")}
            markSensitive={(candidate) =>
              void reviewCandidateStatus(candidate, "blocked_sensitive", "記憶を要確認扱いにしました。")
            }
            goHome={() => setView("home")}
            goConnections={() => setView("connections")}
            sources={state.sources}
            contextPacks={state.contextPacks}
            manualTitle={manualTitle}
            manualBody={manualBody}
            setManualTitle={setManualTitle}
            setManualBody={setManualBody}
            addManualSource={addManualSource}
            handleFileUpload={handleFileUpload}
            ocrExtractionAvailable={ocrExtractionAvailable}
            ocrProviderLabel={ocrProviderLabel}
            legacyOfficeConversionAvailable={legacyOfficeConversionAvailable}
            legacyOfficeProviderLabel={legacyOfficeProviderLabel}
            sourceAccept={sourceAccept}
            sourceLabel={sourceLabel}
            uploadFeedback={uploadFeedback}
            changeSourceLifecycle={changeSourceLifecycle}
            editSourceMetadata={editSourceMetadata}
            editSourceBody={editSourceBody}
          />
        )}
        {view === "connections" && (
          <>
            <ConnectView
              nativePath={nativePath}
              claudeInstallBusy={claudeInstallBusy}
              claudeInstallResult={claudeInstallResult}
              claudeConfig={claudeConfig}
              installClaudeConfig={installClaudeConfig}
              loginItemStatus={loginItemStatus}
              loginItemBusy={loginItemBusy}
              enableLoginItem={enableLoginItem}
              disableLoginItem={disableLoginItem}
              goRequests={() => setView("requests")}
            />
            {state.accessPolicies.length > 0 && (
              <div className="qv-connect" style={{ paddingTop: 0 }}>
                <SectionDivider label="AIに自動で渡す" />
                <Card>
                  {state.accessPolicies.map((policy) => {
                    const clientKind = policy.clientId.replace(/^conn_/, "");
                    const session = state.connectorSessions.find(
                      (s) => s.clientKind === clientKind
                    );
                    const displayName =
                      session?.clientName ??
                      CLIENT_LABELS[clientKind] ??
                      policy.clientId;
                    const thresholdLabel = (() => {
                      switch (policy.requiresApprovalAbove) {
                        case "public": return "public より上は確認";
                        case "personal": return "personal より上は確認";
                        case "private_consequential": return "private より上は確認";
                        case "sensitive": return "sensitive より上は確認";
                        case "secret_never_send": return "すべて確認なし（非推奨）";
                        default: return String(policy.requiresApprovalAbove);
                      }
                    })();
                    return (
                      <div key={policy.clientId} className="qv-standing-row">
                        <div className="qv-standing-row__info">
                          <p className="qv-standing-row__name">{displayName}</p>
                        </div>
                        <Toggle
                          id={`standing-${policy.clientId}`}
                          checked={policy.standingDeliveryEnabled === true}
                          onChange={(checked) => setStandingDelivery(policy.clientId, checked)}
                          label={`${displayName}：自動で渡す（低感度のみ）／毎回確認`}
                        />
                        <DetailsDisclosure>
                          <span>確認のしきい値: {thresholdLabel}</span>
                        </DetailsDisclosure>
                      </div>
                    );
                  })}
                  <p className="qv-standing-note">
                    オンにすると低感度の記憶はAIへ自動で渡されます。要確認の記憶は引き続きあなたの確認が必要です。
                  </p>
                </Card>
              </div>
            )}
          </>
        )}
        {view === "requests" && (
          <ContextRequestsView
            question={question}
            setQuestion={setQuestion}
            requestClientId={requestClientId}
            setRequestClientId={setRequestClientId}
            connectors={state.connectorSessions}
            buildPack={buildPack}
            requests={state.contextPackRequests}
            setActiveRequest={(request) => {
              setActiveRequestId(request.id);
              setActivePackId(state.contextPacks.find((pack) => pack.requestId === request.id)?.id ?? null);
            }}
            currentRequest={currentRequest}
            currentPack={currentPack}
            facts={state.facts}
            approvePackForAi={approvePackForAi}
            copyPackForAi={copyPackForAi}
            generateAnswer={generateAnswer}
            denyActiveRequest={denyActiveRequest}
            changePackItemVisibility={changePackItemVisibility}
            manualCopyPayload={manualCopyPayload}
            recordManualCopyDelivery={recordManualCopyDelivery}
            clearManualCopyPayload={() => setManualCopyPayload(null)}
          />
        )}
        {view === "search" && (
          <SearchView
            query={searchQuery}
            setQuery={setSearchQuery}
            domainFilter={domainFilter}
            setDomainFilter={setDomainFilter}
            sensitivityFilter={sensitivityFilter}
            setSensitivityFilter={setSensitivityFilter}
            facts={state.facts}
            results={searchResults}
            reviewFacts={reviewFacts}
            supersededFacts={supersededFacts}
            sources={state.sources}
            changeFactLifecycle={changeFactLifecycle}
            editFactMetadata={editFactMetadata}
            searchMode={searchMode}
            searchError={searchError}
            nativePath={nativePath}
            goInbox={() => setView("sources")}
            goSources={() => setView("sources")}
          />
        )}
        {view === "settings" && (
          <SettingsView
            passphrase={backupPassphrase}
            setPassphrase={setBackupPassphrase}
            backupText={backupText}
            setBackupText={setBackupText}
            exportBackup={exportBackup}
            previewRestoreBackup={previewRestoreBackup}
            restoreBackup={restoreBackup}
            restorePreview={restorePreview}
            restoreConfirmText={restoreConfirmText}
            setRestoreConfirmText={setRestoreConfirmText}
            clearVault={clearVault}
            clearConfirmText={clearConfirmText}
            setClearConfirmText={setClearConfirmText}
            clearImpactSections={clearVaultImpactSections(state)}
            seedDemo={seedDemo}
            nativePath={nativePath}
            nativeRevision={nativeRevision}
            storageReady={storageReady}
            runtimePreferences={runtimePreferences}
            ocrProviderCandidates={ocrProviderCandidates}
            legacyOfficeProviderCandidates={legacyOfficeProviderCandidates}
            updateRuntimePreference={updateRuntimePreference}
            setDeliveryNotificationsEnabled={setDeliveryNotificationsEnabled}
            copyText={copyText}
          />
        )}
      </main>
    </div>
  );
}
function ContextRequestsView({
  question,
  setQuestion,
  requestClientId,
  setRequestClientId,
  connectors,
  buildPack,
  requests,
  setActiveRequest,
  currentRequest,
  currentPack,
  facts,
  approvePackForAi,
  copyPackForAi,
  generateAnswer,
  denyActiveRequest,
  changePackItemVisibility,
  manualCopyPayload,
  recordManualCopyDelivery,
  clearManualCopyPayload
}: {
  question: string;
  setQuestion: (value: string) => void;
  requestClientId: string;
  setRequestClientId: (value: string) => void;
  connectors: ConnectorSession[];
  buildPack: () => void | Promise<void>;
  requests: ContextPackRequest[];
  setActiveRequest: (request: ContextPackRequest) => void;
  currentRequest: ContextPackRequest | null;
  currentPack: ContextPack | null;
  facts: ApprovedFact[];
  approvePackForAi: (pack: ContextPack) => void;
  copyPackForAi: (pack: ContextPack) => void;
  generateAnswer: (pack: ContextPack) => void;
  denyActiveRequest: () => void;
  changePackItemVisibility: (pack: ContextPack, factId: string, included: boolean) => void;
  manualCopyPayload: ManualCopyPayload | null;
  recordManualCopyDelivery: (packId: string) => void;
  clearManualCopyPayload: () => void;
}) {
  const nowMs = Date.now();
  const currentDeliveryState = currentPack ? contextPackDeliveryState(currentPack, currentRequest, nowMs) : null;
  const aiReady = Boolean(currentDeliveryState?.canDeliver);
  const requestClosed = Boolean(currentDeliveryState?.closed);
  const hiddenExcludedFacts = currentPack
    ? currentPack.excludedItems
        .filter((item) => item.reason === "user_hidden")
        .map((item) => ({
          exclusion: item,
          fact: facts.find((fact) => fact.id === item.referencedId)
        }))
    : [];
  const activeManualCopyPayload = manualCopyPayloadForPack(manualCopyPayload, currentPack);
  const pendingReviewRequests = requests.filter(
    (request) => effectiveRequestStatus(request, nowMs) === "pending_user_confirmation"
  );
  const unreturnedLowRiskRequests = requests.filter((request) => effectiveRequestStatus(request, nowMs) === "approved");
  const actionableRequests = requests.filter((request) => requestNeedsUserAction(request, nowMs));
  const readyRequests = requests.filter((request) => effectiveRequestStatus(request, nowMs) === "fulfilled");
  const closedRequests = requests.filter((request) => {
    const status = effectiveRequestStatus(request, nowMs);
    return status === "denied" || status === "expired";
  });
  const showCopyFallbackStarter = shouldShowCopyFallbackStarter(requests, currentPack);
  const boundaryReceiptItems = currentPack ? contextPackBoundaryReceipt(currentPack, currentRequest, nowMs) : [];
  const requestQueueTitle =
    pendingReviewRequests.length > 0
      ? `${pendingReviewRequests.length}件の確認待ち`
      : unreturnedLowRiskRequests.length > 0
        ? `${unreturnedLowRiskRequests.length}件の返却待ち`
        : "今は対応待ちはありません";
  const requestQueueBody =
    pendingReviewRequests.length > 0
      ? "外部AIへ返す前に、使う記憶・根拠・除外理由を確認できます。"
      : unreturnedLowRiskRequests.length > 0
        ? "低リスクでも、AIへ返す前に送信内容をここで確認できます。"
        : showCopyFallbackStarter
          ? "新しいAI要求が届くとここに並びます。MCPなしで使う場合は下でAIに渡す内容（記憶）を作成します。"
          : "新しいAI要求が届くとここに並びます。手動テストは下の折りたたみから試せます。";
  const requestComposer = (buttonLabel: string) => (
    <div className="form-stack">
      <label className="field">
        <span>AIクライアント</span>
        <select value={requestClientId} onChange={(event) => setRequestClientId(event.target.value)}>
          {connectors
            .filter((connector) => connector.scopes.includes("context_pack.request"))
            .map((connector) => (
              <option key={connector.id} value={connector.id}>
                {connector.clientName}
              </option>
            ))}
        </select>
      </label>
      <Textarea label="質問" value={question} onChange={setQuestion} placeholder="例: 今週の計画を生活背景込みで手伝って" />
      <button className="primary-button" onClick={buildPack} type="button">
        <Sparkles size={16} />
        {buttonLabel}
      </button>
      <p className="muted">MCPなしでも、AIへ渡す前に同じ内容（記憶）の確認とAuditを通します。</p>
    </div>
  );
  const packPanelRef = useRef<HTMLDivElement | null>(null);
  const packActionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!currentPack || !window.matchMedia("(max-width: 980px)").matches) {
      return;
    }
    packActionRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [currentPack?.id]);

  return (
    <section className={currentPack ? "ask-layout has-active-pack" : "ask-layout"}>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI confirmation inbox</p>
            <h3>AIへ返す前の確認待ち</h3>
          </div>
          <Send size={18} />
        </div>
        <div className={actionableRequests.length > 0 ? "request-inbox-summary attention" : "request-inbox-summary"}>
          {actionableRequests.length > 0 ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
          <div>
            <strong>{requestQueueTitle}</strong>
            <span>{requestQueueBody}</span>
          </div>
        </div>
        <div className="request-inbox-metrics">
          <Metric label="対応待ち" value={actionableRequests.length} />
          <Metric label="AI取得可" value={readyRequests.length} />
          <Metric label="終了" value={closedRequests.length} />
        </div>
        <div className="request-list">
          {requests.slice(0, 8).map((request) => (
            <button
              className={`request-row ${requestStatusTone(effectiveRequestStatus(request, nowMs))}${currentRequest?.id === request.id ? " active" : ""}`}
              key={request.id}
              onClick={() => setActiveRequest(request)}
              type="button"
            >
              <span>{request.clientName}</span>
              <strong>{requestStatusLabel(effectiveRequestStatus(request, nowMs))}</strong>
              <small>{request.taskText}</small>
              <small>{formatDateTime(request.createdAt)} / {formatDateTime(request.expiresAt)}まで</small>
            </button>
          ))}
          {requests.length === 0 && (
            <EmptyState
              title="まだAI要求はありません"
              body="ChatGPT/Claudeなどから要求が届くと、AIへ返す前にこのInboxで確認できます。MCPなしで使う場合は下でAIに渡す内容（記憶）を作成します。"
            />
          )}
        </div>
        {showCopyFallbackStarter ? (
          <div className="copy-fallback-starter">
            <div className="panel-heading compact-heading">
              <div>
                <p className="eyebrow">コピーFallback</p>
                <h3>MCPなしでAIに渡す内容（記憶）を作る</h3>
              </div>
              <Clipboard size={18} />
            </div>
            <div className="trust-note">
              <ShieldCheck size={16} />
              <span>ここで作ったPackも、確認画面で許可またはコピーするまでAIには渡りません。</span>
            </div>
            {requestComposer("確認用にAIに渡す内容（記憶）を作成")}
          </div>
        ) : (
          <details className="advanced-panel request-test-panel">
            <summary>手動でAIに渡す内容（記憶）を試す</summary>
            {requestComposer("テスト要求を作成")}
          </details>
        )}
      </div>

      <div className="panel context-pack-panel" ref={packPanelRef}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI-bound preview</p>
            <h3>この内容だけAIへ渡す</h3>
          </div>
          {currentRequest && <Badge>{currentRequest.clientName}</Badge>}
        </div>
        {currentPack && (
          <>
            <div className="pack-summary top-pack-summary">
              <Badge>{currentPack.riskLevel} risk</Badge>
              <SensitivityBadge sensitivity={currentPack.maxSensitivityIncluded} />
              <Badge>{packConfirmationLabel(currentPack.confirmationStatus)}</Badge>
            </div>
            <div className="action-row pack-action-row" ref={packActionRef}>
              <button
                className="primary-button"
                disabled={requestClosed || aiReady}
                onClick={() => approvePackForAi(currentPack)}
                type="button"
              >
                <CheckCircle2 size={16} />
                {currentDeliveryState?.requiresApproval ? "この内容だけAIへ許可" : "この内容だけAIへ返す"}
              </button>
              <button
                className="secondary-button"
                disabled={requestClosed}
                onClick={() => copyPackForAi(currentPack)}
                type="button"
              >
                <Clipboard size={16} />
                {aiReady ? "ChatGPT/Claude用にコピー" : "確認してコピー"}
              </button>
              <button
                className="secondary-button"
                disabled={requestClosed}
                onClick={() => generateAnswer(currentPack)}
                type="button"
              >
                <Check size={16} />
                ローカル回答を下書き
              </button>
              <button className="danger-button" disabled={requestClosed} onClick={denyActiveRequest} type="button">
                <X size={16} />
                AIへ渡さず拒否
              </button>
            </div>
          </>
        )}
        {currentRequest && (
          <div className="request-detail">
            <Metric label="目的" value={currentRequest.purpose} />
            <Metric label="期限" value={formatDateTime(currentRequest.expiresAt)} />
            <Metric label="感度上限" value={<SensitivityBadge sensitivity={currentRequest.sensitivityCeiling} />} />
            <Metric label="状態" value={requestStatusLabel(effectiveRequestStatus(currentRequest, nowMs))} />
          </div>
        )}
        {!currentPack ? (
          <p className="muted">AI要求を選ぶと、送信予定の背景情報と根拠がここに表示されます。</p>
        ) : (
          <div className="context-pack">
            <div className={aiReady ? "pack-delivery ready" : "pack-delivery attention"}>
              {aiReady ? <CheckCircle2 size={18} /> : <Clock size={18} />}
              <div>
                <strong>{packDeliveryTitle(currentDeliveryState)}</strong>
                <span>
                  {packDeliveryBody(currentDeliveryState)}
                </span>
              </div>
            </div>
            <div className="pack-scope-summary">
              <ShieldCheck size={16} />
              <span>
                {currentPack.items.length}件の記憶と{currentPack.sourceSnippets?.length ?? 0}件の根拠snippetだけを送信予定。除外は{currentPack.excludedItems.length}件です。
              </span>
            </div>
            <div className="pack-boundary-receipt-grid" aria-label="Context Pack delivery boundary">
              {boundaryReceiptItems.map((item) => (
                <div className={`pack-boundary-receipt ${item.tone}`} key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.detail}</small>
                </div>
              ))}
            </div>
            {activeManualCopyPayload && (
              <div className="manual-copy-panel">
                <div className="trust-note">
                  <Clipboard size={16} />
                  <span>
                    Clipboardに書き込めない環境です。下のPayloadを選択してAIへ貼り付け、完了後にAuditへ記録します。
                  </span>
                </div>
                <label className="field manual-copy-field">
                  <span>AIへ貼り付けるContext Pack payload</span>
                  <textarea
                    readOnly
                    value={activeManualCopyPayload.payloadText}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </label>
                <div className="action-row manual-copy-actions">
                  <button
                    className="primary-button"
                    onClick={() => recordManualCopyDelivery(activeManualCopyPayload.packId)}
                    type="button"
                  >
                    <CheckCircle2 size={16} />
                    手動コピー済みとしてAudit記録
                  </button>
                  <button className="secondary-button" onClick={clearManualCopyPayload} type="button">
                    <X size={16} />
                    閉じる
                  </button>
                </div>
              </div>
            )}
            {currentPack.warnings.map((warning) => (
              <div className="warning-line" key={warning.message}>
                <ShieldAlert size={16} />
                {warning.message}
              </div>
            ))}
            <div className="context-items">
              {currentPack.items.map((item) => (
                <div className="context-item" key={item.id}>
                  <p>{item.itemText}</p>
                  <div className="context-item-footer">
                    <div>
                      <SensitivityBadge sensitivity={item.sensitivity} />
                      <span>{item.sourceTitles.join(", ")}</span>
                    </div>
                    <small>{item.reasonIncluded}</small>
                    <button
                      className="secondary-button"
                      disabled={requestClosed || aiReady}
                      onClick={() => changePackItemVisibility(currentPack, item.factId, false)}
                      type="button"
                    >
                      <EyeOff size={16} />
                      このAIには渡さない
                    </button>
                  </div>
                </div>
              ))}
              {currentPack.items.length === 0 && <p className="muted">使える承認済みの記憶がまだありません。</p>}
            </div>
            <div className="source-snippet-list">
              <strong>AIへ渡る根拠snippet</strong>
              {currentPack.sourceSnippets && currentPack.sourceSnippets.length > 0 ? (
                currentPack.sourceSnippets.slice(0, 5).map((snippet) => (
                  <div className="source-snippet" key={snippet.id}>
                    <div>
                      <span>{snippet.title}</span>
                      <SensitivityBadge sensitivity={snippet.sensitivity} />
                    </div>
                    <p>{snippet.text}</p>
                    <small>{snippet.reasonIncluded}</small>
                  </div>
                ))
              ) : (
                <div className="source-snippet empty">
                  <div>
                    <span>今回はSource snippetを送信しません</span>
                    <Badge>0 snippets</Badge>
                  </div>
                  <p>Raw Source本文や高感度SourceタイトルはAIへ渡しません。上の記憶の本文と理由だけがPack本文に含まれます。</p>
                  <small>出典確認が必要な場合は、Sourcesで元データとポリシーを確認できます。</small>
                </div>
              )}
            </div>
            {currentPack.excludedItems.length > 0 && (
              <div className="exclusion-list">
                <strong>{currentPack.excludedItems.length}件は送信対象から除外</strong>
                {currentPack.excludedItems.slice(0, 4).map((item) => (
                  <span key={`${item.referencedId}-${item.reason}`}>
                    {exclusionReasonLabel(item.reason)}
                  </span>
                ))}
              </div>
            )}
            {hiddenExcludedFacts.length > 0 && (
              <div className="excluded-context-items">
                <strong>あなたがこのAIから外した記憶</strong>
                {hiddenExcludedFacts.map(({ exclusion, fact }) => (
                  <div className="excluded-context-item" key={`${exclusion.referencedId}-${exclusion.reason}`}>
                    <span>{fact?.factText ?? exclusion.referencedId}</span>
                    <button
                      className="secondary-button"
                      disabled={requestClosed || aiReady}
                      onClick={() => changePackItemVisibility(currentPack, exclusion.referencedId, true)}
                      type="button"
                    >
                      <RefreshCw size={16} />
                      戻す
                    </button>
                  </div>
                ))}
              </div>
            )}
            {currentPack.localAnswer && <pre className="answer-box">{currentPack.localAnswer}</pre>}
          </div>
        )}
      </div>
    </section>
  );
}

function SearchView({
  query,
  setQuery,
  domainFilter,
  setDomainFilter,
  sensitivityFilter,
  setSensitivityFilter,
  facts,
  results,
  reviewFacts,
  supersededFacts,
  sources,
  changeFactLifecycle,
  editFactMetadata,
  searchMode,
  searchError,
  nativePath,
  goInbox,
  goSources
}: {
  query: string;
  setQuery: (value: string) => void;
  domainFilter: LifeContextDomain | "all";
  setDomainFilter: (value: LifeContextDomain | "all") => void;
  sensitivityFilter: SensitivityTier | "all";
  setSensitivityFilter: (value: SensitivityTier | "all") => void;
  facts: ApprovedFact[];
  results: ApprovedFact[];
  reviewFacts: ApprovedFact[];
  supersededFacts: ApprovedFact[];
  sources: VaultState["sources"];
  changeFactLifecycle: (factId: string, action: FactLifecycleAction) => void;
  editFactMetadata: (factId: string, input: FactMetadataUpdate) => Promise<boolean>;
  searchMode: SearchMode;
  searchError: string | null;
  nativePath: string | null;
  goInbox: () => void;
  goSources: () => void;
}) {
  const modeCopy = searchModeCopy(searchMode, Boolean(nativePath));
  const inventory = factInventoryCounts(facts);
  const filteredExcludedFacts = facts
    .filter(
      (fact) =>
        ["user_hidden", "deleted"].includes(fact.status) &&
        (domainFilter === "all" || fact.domain === domainFilter) &&
        (sensitivityFilter === "all" || fact.sensitivity === sensitivityFilter) &&
        (!query.trim() || fact.factText.toLowerCase().includes(query.trim().toLowerCase()))
    )
    .slice(0, 25);
  const hasAnyFact = inventory.total > 0;
  return (
    <section className="panel wide">
      <div className="memory-inventory-panel">
        <div className="panel-heading compact-heading">
          <div>
            <p className="eyebrow">Memory inventory</p>
            <h3>AIが使える保存済みの記憶</h3>
          </div>
          <Badge>{inventory.active} AIに渡す記憶</Badge>
        </div>
        <div className="context-inventory-grid">
          <Metric label="AIに渡す記憶" value={inventory.active} />
          <Metric label="再確認待ち" value={inventory.needsReview} />
          <Metric label="非表示/削除" value={inventory.hiddenOrDeleted} />
          <Metric label="履歴/期限切れ" value={inventory.history} />
        </div>
        <div className={inventory.needsReview > 0 ? "trust-note attention-note" : "trust-note"}>
          <ShieldCheck size={16} />
          <span>
            AIに渡す記憶になるのはActiveな記憶だけです。再確認待ち、非表示、削除済み、期限切れ、置き換え済みの記憶はAIに渡しません。
          </span>
        </div>
        {!hasAnyFact && (
          <div className="action-row inventory-actions">
            <button className="primary-button" onClick={goSources} type="button">
              <FileText size={16} />
              Sourceを追加
            </button>
            <button className="secondary-button" onClick={goInbox} type="button">
              <Inbox size={16} />
              Inboxを確認
            </button>
          </div>
        )}
      </div>
      {reviewFacts.length > 0 && (
        <div className="memory-review-panel">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Needs review</p>
              <h3>AIに使う前に確認が必要な記憶</h3>
            </div>
            <Badge>{reviewFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <ShieldAlert size={16} />
            <span>Sourceが停止・本文消去・本文更新された記憶です。保持するとAIに渡す記憶へ戻り、非表示/削除すると既存の内容（記憶）も無効化されます。</span>
          </div>
          <div className="domain-list">
            {reviewFacts.map((fact) => (
              <FactRow
                fact={fact}
                key={fact.id}
                sources={sources}
                variant="review"
                changeFactLifecycle={changeFactLifecycle}
                editFactMetadata={editFactMetadata}
              />
            ))}
          </div>
        </div>
      )}
      <div className="search-controls">
        <Input label="検索" value={query} onChange={setQuery} placeholder="背景、期限、契約、制約など" />
        <label>
          <span>Domain</span>
          <select value={domainFilter} onChange={(event) => setDomainFilter(event.target.value as LifeContextDomain | "all")}>
            {domainOptions.map((domain) => (
              <option value={domain} key={domain}>
                {domain === "all" ? "All" : domainLabel(domain)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Sensitivity</span>
          <select value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value as SensitivityTier | "all")}>
            {sensitivityOptions.map((sensitivity) => (
              <option value={sensitivity} key={sensitivity}>
                {sensitivity === "all" ? "All" : sensitivityLabel(sensitivity)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={`search-mode-row ${modeCopy.tone}`}>
        <div>
          <strong>{modeCopy.title}</strong>
          <span>{modeCopy.body}</span>
          {searchError && <span>{searchError}</span>}
        </div>
        <Badge>{results.length}件</Badge>
      </div>
      <div className="domain-list">
        {results.map((fact) => (
          <FactRow
            fact={fact}
            key={fact.id}
            sources={sources}
            variant="active"
            changeFactLifecycle={changeFactLifecycle}
            editFactMetadata={editFactMetadata}
          />
        ))}
        {results.length === 0 && <p className="muted">一致する記憶がありません。</p>}
      </div>
      {filteredExcludedFacts.length > 0 && (
        <div className="memory-review-panel excluded-facts-panel">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Outside AI context</p>
              <h3>AIに渡す記憶から外れている記憶</h3>
            </div>
            <Badge>{filteredExcludedFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <EyeOff size={16} />
            <span>非表示、削除済みの記憶です。AIに使う必要が戻ったものだけ、明示的にAIに渡す記憶へ戻します。</span>
          </div>
          <div className="domain-list">
            {filteredExcludedFacts.map((fact) => (
              <FactRow
                changeFactLifecycle={changeFactLifecycle}
                fact={fact}
                key={fact.id}
                sources={sources}
                variant="excluded"
              />
            ))}
          </div>
        </div>
      )}
      {supersededFacts.length > 0 && (
        <div className="memory-review-panel version-history-panel">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Version history</p>
              <h3>置き換え済みの記憶</h3>
            </div>
            <Badge>{supersededFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <RefreshCw size={16} />
            <span>ここにある記憶は履歴として残っていますが、通常の検索結果やAIに渡す記憶には入りません。</span>
          </div>
          <div className="domain-list">
            {supersededFacts.map((fact) => (
              <FactRow fact={fact} key={fact.id} sources={sources} variant="readonly" />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsView({
  passphrase,
  setPassphrase,
  backupText,
  setBackupText,
  exportBackup,
  previewRestoreBackup,
  restoreBackup,
  restorePreview,
  restoreConfirmText,
  setRestoreConfirmText,
  clearVault,
  clearConfirmText,
  setClearConfirmText,
  clearImpactSections,
  seedDemo,
  nativePath,
  nativeRevision,
  storageReady,
  runtimePreferences,
  ocrProviderCandidates,
  legacyOfficeProviderCandidates,
  updateRuntimePreference,
  setDeliveryNotificationsEnabled,
  copyText
}: {
  passphrase: string;
  setPassphrase: (value: string) => void;
  backupText: string;
  setBackupText: (value: string) => void;
  exportBackup: () => void;
  previewRestoreBackup: () => void;
  restoreBackup: () => void;
  restorePreview: RestorePreview | null;
  restoreConfirmText: string;
  setRestoreConfirmText: (value: string) => void;
  clearVault: () => void;
  clearConfirmText: string;
  setClearConfirmText: (value: string) => void;
  clearImpactSections: ClearImpactSection[];
  seedDemo: () => void;
  nativePath: string | null;
  nativeRevision: string | null;
  storageReady: boolean;
  runtimePreferences: RuntimePreferences;
  ocrProviderCandidates: NativeOcrProviderCandidate[];
  legacyOfficeProviderCandidates: NativeLegacyOfficeProviderCandidate[];
  updateRuntimePreference: (next: Partial<RuntimePreferences>) => void;
  setDeliveryNotificationsEnabled: (enabled: boolean) => Promise<void>;
  copyText: (value: string, message: string) => Promise<boolean>;
}) {
  const hasOcrCommand = Boolean(runtimePreferences.ocrCommand.trim());
  const hasLegacyOfficeCommand = Boolean(runtimePreferences.legacyOfficeCommand.trim());
  const ocrInstallGuides = ocrInstallerGuidesForPlatform();
  const legacyOfficeInstallGuides = legacyOfficeInstallGuidesForPlatform();
  return (
    <section className="view-grid">
      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">バックアップ</p>
            <h3>暗号化バックアップ</h3>
          </div>
          <Lock size={18} />
        </div>
        <div className="form-stack">
          <Input label="パスフレーズ" value={passphrase} onChange={setPassphrase} placeholder="12文字以上・3種類以上の文字を含める" type="password" />
          <div className="trust-note attention-note">
            <ShieldAlert size={16} />
            <span>バックアップにはVault内の生活コンテキスト全体が入ります。推測されにくい長いパスフレーズを使い、共有や保管場所に注意してください。</span>
          </div>
          <button className="primary-button" onClick={exportBackup} type="button">
            <Download size={16} />
            バックアップを作成
          </button>
          <Textarea label="バックアップJSON" value={backupText} onChange={setBackupText} placeholder="復元する場合はここに貼り付け" />
          <div className="restore-actions">
            <button className="secondary-button" onClick={previewRestoreBackup} type="button">
              <Search size={16} />
              復元プレビュー
            </button>
            <button
              className="danger-button"
              disabled={!restorePreview || restoreConfirmText !== "RESTORE"}
              onClick={restoreBackup}
              type="button"
            >
              <Upload size={16} />
              現在のVaultを置き換える
            </button>
          </div>
          {restorePreview ? (
            <div className="restore-preview">
              <div className="restore-preview-grid">
                <Metric label="元データ" value={restorePreview.counts.sources} />
                <Metric label="保存済みの記憶" value={restorePreview.counts.facts} />
                <Metric label="Inboxの記憶" value={restorePreview.counts.candidates} />
                <Metric label="AIに渡した内容（記憶）" value={restorePreview.counts.packs} />
                <Metric label="依頼" value={restorePreview.counts.requests} />
                <Metric label="Capture" value={restorePreview.counts.captureEvents} />
                <Metric label="AI接続" value={restorePreview.counts.connectorSessions} />
                <Metric label="Policy" value={restorePreview.counts.policies} />
                <Metric label="Audit" value={restorePreview.counts.auditEvents} />
              </div>
              <div className="restore-receipt-grid">
                <div>
                  <p className="eyebrow">バックアップに含まれるもの</p>
                  <div className="restore-receipt-list">
                    {restorePreview.receiptSections.map((section) => (
                      <div className={`restore-receipt ${section.tone}`} key={section.label}>
                        <strong>{section.label}</strong>
                        <span>{section.value}</span>
                        <small>{section.detail}</small>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="eyebrow">現在のVaultから置き換わるもの</p>
                  <div className="restore-receipt-list">
                    {restorePreview.overwriteSections.map((section) => (
                      <div className={`restore-receipt ${section.tone}`} key={section.label}>
                        <strong>{section.label}</strong>
                        <span>{section.value}</span>
                        <small>{section.detail}</small>
                      </div>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="eyebrow">復元後のAI境界</p>
                  <div className="restore-receipt-list">
                    {restorePreview.aiBoundarySections.map((section) => (
                      <div className={`restore-receipt ${section.tone}`} key={section.label}>
                        <strong>{section.label}</strong>
                        <span>{section.value}</span>
                        <small>{section.detail}</small>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="trust-note attention-note">
                <ShieldAlert size={16} />
                <span>
                  復元すると現在のVault全体をこのバックアップで置き換えます。内容の最高感度は{restorePreview.sensitivitySummary}です。
                  {restorePreview.newestSourceAt ? ` 最新Source: ${formatDateTime(restorePreview.newestSourceAt)}。` : ""}
                  {restorePreview.oldestAuditAt ? ` Auditは${formatDateTime(restorePreview.oldestAuditAt)}以降を含みます。` : ""}
                  {restorePreview.expiredCaptureCount > 0 ? ` TTL切れCaptureが${restorePreview.expiredCaptureCount}件あります。` : ""}
                </span>
              </div>
              <Input
                label="復元確認"
                value={restoreConfirmText}
                onChange={setRestoreConfirmText}
                placeholder="RESTORE と入力"
              />
            </div>
          ) : (
            <p className="muted">復元前にバックアップJSONを復号し、件数と感度を確認します。確認前に現在のVaultは変更されません。</p>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">旧Office変換</p>
            <h3>DOC / XLS / PPTを変換して読む</h3>
          </div>
          <Badge>{hasLegacyOfficeCommand ? "設定済み" : "停止中"}</Badge>
        </div>
        <div className="form-stack">
          <div className="trust-note">
            <ShieldCheck size={16} />
            <span>旧Office変換は指定したローカルコマンドだけを実行します。変換後の本文はSourceと確認待ちの記憶になり、承認前にAIへ渡りません。</span>
          </div>
          {legacyOfficeProviderCandidates.length > 0 ? (
            <div className="table-list">
              {legacyOfficeProviderCandidates.map((candidate) => (
                <div className="table-row" key={`${candidate.source}:${candidate.command}`}>
                  <div>
                    <strong>{candidate.label}</strong>
                    <span>{candidate.command}</span>
                    <span>検出だけを行い、ここではLibreOffice実行や文書送信はしていません。</span>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      updateRuntimePreference({
                        legacyOfficeCommand: candidate.command,
                        legacyOfficeArgs: candidate.args,
                        legacyOfficeTimeoutSeconds: candidate.timeoutSeconds
                      })
                    }
                    type="button"
                  >
                    <Check size={16} />
                    このコマンドを使う
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="trust-note">
              <ShieldAlert size={16} />
              <span>LibreOfficeはまだ見つかっていません。インストール後にこの画面を開き直すか、下の変換コマンドへローカル変換コマンドを直接入力してください。</span>
            </div>
          )}
          <div className="table-list">
            {legacyOfficeInstallGuides.map((guide) => (
              <div className="table-row" key={guide.id}>
                <div>
                  <strong>{guide.label}</strong>
                  <span>{guide.description}</span>
                  <code>{guide.installCommand}</code>
                </div>
                <div className="action-row compact-actions">
                  <button
                    className="secondary-button"
                    onClick={() => copyText(guide.installCommand, `${guide.label}のLibreOfficeインストールコマンドをコピーしました。`)}
                    type="button"
                  >
                    <Clipboard size={16} />
                    コピー
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      updateRuntimePreference({
                        legacyOfficeCommand: guide.command,
                        legacyOfficeArgs: guide.args,
                        legacyOfficeTimeoutSeconds: 60
                      })
                    }
                    type="button"
                  >
                    <Settings size={16} />
                    パスを反映
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Input
            label="変換コマンド"
            value={runtimePreferences.legacyOfficeCommand}
            onChange={(value) => updateRuntimePreference({ legacyOfficeCommand: value })}
            placeholder="/Applications/LibreOffice.app/Contents/MacOS/soffice"
          />
          <Textarea
            label="引数"
            value={runtimePreferences.legacyOfficeArgs}
            onChange={(value) => updateRuntimePreference({ legacyOfficeArgs: value })}
            placeholder="--headless --convert-to {target_ext} --outdir {output_dir} {input}"
          />
          <Input
            label="タイムアウト秒"
            value={String(runtimePreferences.legacyOfficeTimeoutSeconds)}
            onChange={(value) =>
              updateRuntimePreference({ legacyOfficeTimeoutSeconds: normalizedOcrTimeout(Number(value), 60) })
            }
            type="number"
          />
          <div className="action-row">
            <button
              className="secondary-button"
              onClick={() =>
                updateRuntimePreference({
                  legacyOfficeArgs: "--headless --convert-to {target_ext} --outdir {output_dir} {input}"
                })
              }
              type="button"
            >
              <Settings size={16} />
              LibreOffice引数
            </button>
            <button
              className="danger-button"
              onClick={() =>
                updateRuntimePreference({
                  legacyOfficeCommand: "",
                  legacyOfficeArgs: "--headless --convert-to {target_ext} --outdir {output_dir} {input}",
                  legacyOfficeTimeoutSeconds: 60
                })
              }
              type="button"
            >
              <X size={16} />
              設定を消す
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">保存先</p>
            <h3>Vault保存先</h3>
          </div>
          <Lock size={18} />
        </div>
        <div className="table-list">
          <div className="table-row">
            <div>
              <strong>{nativePath ? "暗号化SQLite + OS Keychain" : "Browser localStorage"}</strong>
              <span>
                {nativePath
                  ? `${nativePath} / Vault鍵はOSの安全な資格情報ストアで管理 / 最終同期: ${nativeRevision ? new Date(nativeRevision).toLocaleString() : "未保存"}`
                  : "Tauri外ではブラウザのlocalStorageに保存します。"}
              </span>
            </div>
            <Badge>{storageReady ? "準備完了" : "読み込み中"}</Badge>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">ローカルOCR</p>
            <h3>画像本文の抽出</h3>
          </div>
          <Badge>{hasOcrCommand ? "設定済み" : "停止中"}</Badge>
        </div>
        <div className="form-stack">
          <div className="trust-note">
            <ShieldCheck size={16} />
            <span>画像OCRは指定したローカルコマンドだけを実行します。抽出結果はSourceと確認待ちの記憶になり、承認前にAIへ渡りません。</span>
          </div>
          {ocrProviderCandidates.length > 0 ? (
            <div className="table-list">
              {ocrProviderCandidates.map((candidate) => (
                <div className="table-row" key={`${candidate.source}:${candidate.command}`}>
                  <div>
                    <strong>{candidate.label}</strong>
                    <span>{candidate.command}</span>
                    <span>検出だけを行い、ここではOCR実行や画像送信はしていません。</span>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      updateRuntimePreference({
                        ocrCommand: candidate.command,
                        ocrArgs: candidate.args,
                        ocrTimeoutSeconds: candidate.timeoutSeconds
                      })
                    }
                    type="button"
                  >
                    <Check size={16} />
                    このコマンドを使う
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="trust-note">
              <ShieldAlert size={16} />
              <span>Tesseract OCRはまだ見つかっていません。インストール後にこの画面を開き直すか、下のOCRコマンドへローカルOCRコマンドを直接入力してください。</span>
            </div>
          )}
          <div className="table-list">
            {ocrInstallGuides.map((guide) => (
              <div className="table-row" key={guide.id}>
                <div>
                  <strong>{guide.label}</strong>
                  <span>{guide.description}</span>
                  <code>{guide.installCommand}</code>
                </div>
                <div className="action-row compact-actions">
                  <button
                    className="secondary-button"
                    onClick={() => copyText(guide.installCommand, `${guide.label}のOCRインストールコマンドをコピーしました。`)}
                    type="button"
                  >
                    <Clipboard size={16} />
                    コピー
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() =>
                      updateRuntimePreference({
                        ocrCommand: guide.command,
                        ocrArgs: guide.args,
                        ocrTimeoutSeconds: 30
                      })
                    }
                    type="button"
                  >
                    <Settings size={16} />
                    パスを反映
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Input
            label="OCRコマンド"
            value={runtimePreferences.ocrCommand}
            onChange={(value) => updateRuntimePreference({ ocrCommand: value })}
            placeholder="/opt/homebrew/bin/tesseract"
          />
          <Textarea
            label="引数"
            value={runtimePreferences.ocrArgs}
            onChange={(value) => updateRuntimePreference({ ocrArgs: value })}
            placeholder="{input} stdout -l eng+jpn"
          />
          <Input
            label="タイムアウト秒"
            value={String(runtimePreferences.ocrTimeoutSeconds)}
            onChange={(value) => updateRuntimePreference({ ocrTimeoutSeconds: normalizedOcrTimeout(Number(value)) })}
            type="number"
          />
          <div className="action-row">
            <button
              className="secondary-button"
              onClick={() => updateRuntimePreference({ ocrArgs: "{input} stdout" })}
              type="button"
            >
              <Settings size={16} />
              基本引数
            </button>
            <button
              className="secondary-button"
              onClick={() => updateRuntimePreference({ ocrArgs: "{input} stdout -l jpn+eng" })}
              type="button"
            >
              <Settings size={16} />
              日本語+英語
            </button>
            <button
              className="danger-button"
              onClick={() => updateRuntimePreference({ ocrCommand: "", ocrArgs: "{input}", ocrTimeoutSeconds: 30 })}
              type="button"
            >
              <X size={16} />
              設定を消す
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">配信通知</p>
            <h3>OS通知</h3>
          </div>
          <Badge>
            {runtimePreferences.deliveryNotificationsEnabled ? "有効" : "無効"}
          </Badge>
        </div>
        <p>
          スタンディング配信が承認されたときにOSの通知を受け取ります。有効にするとOS側で通知許可を求めます。
        </p>
        <div className="action-column">
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              void setDeliveryNotificationsEnabled(
                !runtimePreferences.deliveryNotificationsEnabled
              )
            }
          >
            {runtimePreferences.deliveryNotificationsEnabled ? (
              <>
                <X size={16} />
                通知を無効にする
              </>
            ) : (
              <>
                <Bell size={16} />
                通知を有効にする
              </>
            )}
          </button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">デモ</p>
            <h3>検証用操作</h3>
          </div>
        </div>
        <div className="action-column">
          <button className="secondary-button" onClick={seedDemo} type="button">
            <Sparkles size={16} />
            デモデータ投入
          </button>
          <div className="danger-zone">
            <div className="trust-note attention-note">
              <ShieldAlert size={16} />
              <span>Vaultをクリアすると、Sources、記憶、AIに渡した内容（記憶）、接続監査が空になります。バックアップが必要なら先にバックアップを作成してください。</span>
            </div>
            <div className="clear-impact-list" aria-label="Vault clear impact">
              {clearImpactSections.map((section) => (
                <div className={`restore-receipt ${section.tone}`} key={section.label}>
                  <strong>{section.label}</strong>
                  <span>{section.value}</span>
                  <small>{section.detail}</small>
                </div>
              ))}
            </div>
            <Input
              label="クリア確認"
              value={clearConfirmText}
              onChange={setClearConfirmText}
              placeholder="CLEAR と入力"
            />
            <button
              className="danger-button"
              disabled={clearConfirmText !== "CLEAR"}
              onClick={clearVault}
              type="button"
            >
              <X size={16} />
              Vaultをクリア
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function isAiBoundaryAuditEvent(event: AuditEvent): boolean {
  if (event.eventType === "context_pack_delivered") return true;
  if (event.eventType === "context_pack_confirmed") return true;
  if (event.eventType === "context_pack_denied") return true;
  return event.eventType === "context_pack_updated" && metadataString(event, "action") === "policy_invalidated";
}

function auditReceiptTone(event: AuditEvent): "ready" | "attention" | "blocked" {
  if (event.eventType === "context_pack_delivered" || event.eventType === "context_pack_confirmed") return "ready";
  if (event.eventType === "context_pack_denied") return "blocked";
  return "attention";
}

function auditReceiptTitle(event: AuditEvent): string {
  const client = metadataString(event, "clientName") || "AI";
  if (event.eventType === "context_pack_delivered") {
    const channel = deliveryChannelLabel(metadataString(event, "deliveryChannel"));
    return `${client}へ${channel}で渡しました`;
  }
  if (event.eventType === "context_pack_confirmed") return `${client}が取得できる状態にしました`;
  if (event.eventType === "context_pack_denied") return `${client}へのContext Requestを拒否しました`;
  return `${client}へAIに渡す内容（記憶）を送信不可にしました`;
}

export function auditReceiptBody(event: AuditEvent): string {
  const itemCount = metadataNumber(event, "itemCount");
  const snippetCount = metadataNumber(event, "sourceSnippetCount");
  const excludedCount = metadataNumber(event, "excludedCount");
  const ttl = metadataNumber(event, "ttlSeconds");
  const includedDomainLabels = metadataStringArray(event, "includedDomains")
    .filter(isKnownLifeDomain)
    .map(domainLabel);
  const pieces = [
    includedDomainLabels.length > 0 ? `${includedDomainLabels.join("、")}の文脈` : null,
    typeof itemCount === "number" ? `${itemCount}件の記憶` : null,
    typeof snippetCount === "number" ? `${snippetCount}件の根拠スニペット` : null,
    typeof excludedCount === "number" ? `${excludedCount}件を除外` : null,
    ttl ? `有効期限は約${Math.max(1, Math.round(ttl / 60))}分` : null
  ].filter(Boolean);
  const summary = pieces.length > 0 ? pieces.join("、") : "AIに渡した内容（記憶）の本文はAuditに保存していません";
  return `${summary}。Raw Source本文と確認待ちの記憶は含めていません。`;
}

function deliveryChannelLabel(channel: string): string {
  if (channel === "clipboard_copy") return "コピー";

  return channel || "Context Pack";
}

function isKnownLifeDomain(value: string): value is LifeContextDomain {
  return policyDomainOptions.includes(value as LifeContextDomain);
}

function auditEventLabel(event: AuditEvent): string {
  const labels: Partial<Record<AuditEvent["eventType"], string>> = {
    context_pack_requested: "Context Pack要求",
    context_pack_generated: "Context Pack生成",
    context_pack_updated: "Context Pack更新",
    context_pack_confirmed: "Context Pack承認",
    context_pack_delivered: "Context Pack配達",
    context_pack_denied: "Context Request拒否",
    candidate_generated: "候補生成",
    candidate_reviewed: "候補レビュー",
    fact_created: "記憶作成",
    fact_updated: "記憶更新",
    source_added: "Source追加",
    source_updated: "Source更新",
    source_deleted: "Source停止",
    source_restored: "Source復元",
    source_purged: "Source本文消去",
    passive_capture_recorded: "Passive Capture記録",
    passive_capture_purged: "Passive Capture消去",
    policy_updated: "Policy更新",
    memory_proposed: "Memory提案"
  };
  return labels[event.eventType] ?? event.eventType;
}

function auditCompactMetadata(event: AuditEvent): string {
  const client = metadataString(event, "clientName");
  const status = metadataString(event, "deliveryStatus") || metadataString(event, "requestStatus");
  const itemCount = metadataNumber(event, "itemCount");
  const invalidated = metadataNumber(event, "invalidatedPackCount");
  const parts = [
    client ? `AI: ${client}` : null,
    status ? `状態: ${status}` : null,
    typeof itemCount === "number" ? `記憶: ${itemCount}` : null,
    typeof invalidated === "number" ? `失効Pack: ${invalidated}` : null
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" / ") : "本文なしの監査メタデータ";
}

function metadataString(event: AuditEvent, key: string): string {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function metadataNumber(event: AuditEvent, key: string): number | null {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataStringArray(event: AuditEvent, key: string): string[] {
  const value = event.metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function FactRow({
  fact,
  sources = [],
  variant = "readonly",
  changeFactLifecycle,
  editFactMetadata
}: {
  fact: ApprovedFact;
  sources?: VaultState["sources"];
  variant?: "readonly" | "active" | "review" | "excluded";
  changeFactLifecycle?: (factId: string, action: FactLifecycleAction) => void;
  editFactMetadata?: (factId: string, input: FactMetadataUpdate) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<FactMetadataUpdate | null>(null);
  const sourceNames = factSourceNames(fact, sources);
  return (
    <div className="fact-row">
      <div className="fact-main">
        {draft ? (
          <div className="fact-edit-form">
            <Textarea
              label="記憶の本文"
              value={draft.factText}
              onChange={(value) => setDraft({ ...draft, factText: value })}
              placeholder="AIに渡す正本の文脈"
            />
            <div className="fact-edit-grid">
              <label className="field">
                <span>Domain</span>
                <select
                  value={draft.domain}
                  onChange={(event) => setDraft({ ...draft, domain: event.target.value as LifeContextDomain })}
                >
                  {domainOptions.filter((domain) => domain !== "all").map((domain) => (
                    <option key={domain} value={domain}>
                      {domainLabel(domain as LifeContextDomain)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Sensitivity</span>
                <select
                  value={draft.sensitivity}
                  onChange={(event) => setDraft({ ...draft, sensitivity: event.target.value as SensitivityTier })}
                >
                  {policySensitivityOptions.map((sensitivity) => (
                    <option key={sensitivity} value={sensitivity}>
                      {sensitivityLabel(sensitivity)}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                label="有効期限"
                value={draft.validUntil ?? ""}
                onChange={(value) => setDraft({ ...draft, validUntil: value })}
                placeholder="YYYY-MM-DD"
              />
              <Input
                label="期限日"
                value={draft.dueDate ?? ""}
                onChange={(value) => setDraft({ ...draft, dueDate: value })}
                placeholder="YYYY-MM-DD"
              />
            </div>
          </div>
        ) : (
          <>
            <strong>{fact.factText}</strong>
            <span>{domainLabel(fact.domain)} / {memoryStatusLabel(factMemoryStatus(fact.status))}</span>
            <DetailsDisclosure>
              <span>感度: {sensitivityLabel(fact.sensitivity)} / 確信度: {fact.confidence} / 状態: {factStatusLabel(fact.status)}</span>
            </DetailsDisclosure>
            {sourceNames && <span>{sourceNames}</span>}
          </>
        )}
      </div>
      <div className="fact-actions">
        <SensitivityBadge sensitivity={fact.sensitivity} />
        {editFactMetadata && (
          draft ? (
            <>
              <button
                className="primary-button"
                onClick={async () => {
                  const saved = await editFactMetadata(fact.id, draft);
                  if (saved) setDraft(null);
                }}
                type="button"
              >
                <Check size={16} />
                保存
              </button>
              <button className="secondary-button" onClick={() => setDraft(null)} type="button">
                <X size={16} />
                取消
              </button>
            </>
          ) : (
            <button
              className="secondary-button"
              onClick={() =>
                setDraft({
                  factText: fact.factText,
                  domain: fact.domain,
                  sensitivity: fact.sensitivity,
                  validFrom: fact.validFrom,
                  validUntil: fact.validUntil,
                  dueDate: fact.dueDate
                })
              }
              type="button"
            >
              <Settings size={16} />
              編集
            </button>
          )
        )}
        {variant === "review" && changeFactLifecycle && (
          <>
            <button className="primary-button" onClick={() => changeFactLifecycle(fact.id, "keep_active")} type="button">
              <CheckCircle2 size={16} />
              保持
            </button>
            <button className="secondary-button" onClick={() => changeFactLifecycle(fact.id, "hide")} type="button">
              <EyeOff size={16} />
              非表示
            </button>
            <button className="danger-button" onClick={() => changeFactLifecycle(fact.id, "delete")} type="button">
              <Trash2 size={16} />
              削除
            </button>
          </>
        )}
        {variant === "active" && changeFactLifecycle && (
          <>
            <button className="secondary-button" onClick={() => changeFactLifecycle(fact.id, "hide")} type="button">
              <EyeOff size={16} />
              非表示
            </button>
            <button className="danger-button" onClick={() => changeFactLifecycle(fact.id, "delete")} type="button">
              <Trash2 size={16} />
              削除
            </button>
          </>
        )}
        {variant === "excluded" && changeFactLifecycle && (
          <button className="secondary-button" onClick={() => changeFactLifecycle(fact.id, "restore")} type="button">
            <RefreshCw size={16} />
            AIに渡す記憶へ戻す
          </button>
        )}
      </div>
    </div>
  );
}

export function factSourceNames(
  fact: Pick<ApprovedFact, "sourceIds">,
  sources: Array<Pick<RawSource, "id" | "title">>
): string {
  if (fact.sourceIds.length === 0) return "出典なし";
  const visibleNames = fact.sourceIds
    .slice(0, 2)
    .map((sourceId) => sources.find((source) => source.id === sourceId)?.title ?? "Source未検出");
  const hiddenCount = fact.sourceIds.length - visibleNames.length;
  return hiddenCount > 0 ? [...visibleNames, `+${hiddenCount}`].join(", ") : visibleNames.join(", ");
}

export function factInventoryCounts(facts: Array<Pick<ApprovedFact, "status">>): {
  total: number;
  active: number;
  needsReview: number;
  hiddenOrDeleted: number;
  history: number;
} {
  return facts.reduce(
    (counts, fact) => {
      counts.total += 1;
      if (fact.status === "active") counts.active += 1;
      if (fact.status === "needs_review") counts.needsReview += 1;
      if (fact.status === "user_hidden" || fact.status === "deleted") counts.hiddenOrDeleted += 1;
      if (fact.status === "superseded" || fact.status === "expired") counts.history += 1;
      return counts;
    },
    { total: 0, active: 0, needsReview: 0, hiddenOrDeleted: 0, history: 0 }
  );
}

export function sourceReviewCandidates<T extends Pick<MemoryCandidate, "sourceIds" | "status">>(
  candidates: T[]
): T[] {
  return candidates.filter(
    (candidate) =>
      candidate.sourceIds.length > 0 &&
      ["new", "needs_user_detail", "blocked_sensitive"].includes(candidate.status)
  );
}

export function shouldShowCopyFallbackStarter(
  _requests: Array<Pick<ContextPackRequest, "id">>,
  currentPack: Pick<ContextPack, "id"> | null
): boolean {
  return !currentPack;
}
export function homeAiBoundarySections({
  facts,
  candidates,
  requests,
  contextPacks,
  nowMs = Date.now()
}: {
  facts: Array<Pick<ApprovedFact, "status">>;
  candidates: Array<Pick<MemoryCandidate, "status">>;
  requests: Array<Pick<ContextPackRequest, "id" | "status" | "expiresAt">>;
  contextPacks: Array<Pick<ContextPack, "requestId" | "confirmationStatus" | "expiresAt">>;
  nowMs?: number;
}): HomeAiBoundarySection[] {
  const activeFactCount = facts.filter((fact) => fact.status === "active").length;
  const reviewCandidateCount = candidates.filter((candidate) =>
    ["new", "needs_user_detail", "blocked_sensitive"].includes(candidate.status)
  ).length;
  const requestsById = new Map(requests.map((request) => [request.id, request]));
  const actionableRequestCount = requests.filter((request) => {
    const status = effectiveRequestStatus(request, nowMs);
    return status === "pending_user_confirmation" || status === "approved";
  }).length;
  const packStates = contextPacks.map((pack) =>
    contextPackDeliveryState(pack, pack.requestId ? requestsById.get(pack.requestId) ?? null : null, nowMs)
  );
  const deliverablePackCount = packStates.filter((state) => state.canDeliver).length;
  const expiredPackCount = packStates.filter((state) => state.expired).length;

  return [
    {
      label: "AIが使える正本",
      value: `${activeFactCount} 件の記憶`,
      detail:
        activeFactCount > 0
          ? "記憶だけがAIに渡す記憶になります。"
          : "Sourceや記憶だけではAIに渡る文脈になりません。",
      tone: activeFactCount > 0 ? "ready" : "attention"
    },
    {
      label: "未承認で止める",
      value: `${reviewCandidateCount} candidates`,
      detail:
        reviewCandidateCount > 0
          ? "Inboxで保存するまで、記憶はAIの確定文脈に使いません。"
          : "確認待ちの記憶はありません。",
      tone: reviewCandidateCount > 0 ? "attention" : "ready"
    },
    {
      label: "確認/返却待ち",
      value: `${actionableRequestCount} requests`,
      detail:
        actionableRequestCount > 0
          ? "承認、返却、またはコピー操作まではPack本文を外部AIへ返しません。"
          : "いま確認待ちのContext Requestはありません。",
      tone: actionableRequestCount > 0 ? "attention" : "ready"
    },
    {
      label: "AIへ返せるPack",
      value: `${deliverablePackCount} ready`,
      detail:
        expiredPackCount > 0
          ? `${expiredPackCount}件の期限切れPackはAIへ返せません。`
          : deliverablePackCount > 0
            ? "期限内の確認済みPackだけが取得可能です。"
            : "取得可能なPackはありません。必要な時に作成します。",
      tone: deliverablePackCount > 0 ? "attention" : "ready"
    }
  ];
}

export function manualCopyPayloadForPack(
  payload: Pick<ManualCopyPayload, "packId" | "payloadText" | "createdAt"> | null,
  currentPack: Pick<ContextPack, "id"> | null
): Pick<ManualCopyPayload, "packId" | "payloadText" | "createdAt"> | null {
  return payload && currentPack && payload.packId === currentPack.id ? payload : null;
}

export function contextPackBoundaryReceipt(
  pack: Pick<
    ContextPack,
    "items" | "sourceSnippets" | "excludedItems" | "expiresAt" | "confirmationStatus" | "maxSensitivityIncluded"
  >,
  request: Pick<ContextPackRequest, "clientName" | "sensitivityCeiling" | "expiresAt" | "status"> | null,
  nowMs = Date.now()
): ContextPackBoundaryReceiptItem[] {
  const snippetCount = pack.sourceSnippets?.length ?? 0;
  const expiry = pack.expiresAt ?? request?.expiresAt ?? null;
  const expiresAt = expiry ? Date.parse(expiry) : NaN;
  const minutesLeft = Number.isFinite(expiresAt)
    ? Math.max(0, Math.ceil((expiresAt - nowMs) / 60_000))
    : null;
  const clientName = request?.clientName ?? "このAI";
  const deliveryState = contextPackDeliveryState(pack, request, nowMs);
  const waitingDetail =
    pack.confirmationStatus === "not_required"
      ? "返却またはコピーするまでPack本文は外部AIへ返しません。"
      : "承認するまでPack本文は外部AIへ返しません。";
  const excludedReasons = Array.from(new Set(pack.excludedItems.map((item) => exclusionReasonLabel(item.reason))));
  const exclusionDetail =
    excludedReasons.length > 0
      ? `${excludedReasons.slice(0, 3).join("、")}${excludedReasons.length > 3 ? "など" : ""}で除外しています。`
      : "Raw Source本文、確認待ちの記憶、削除済み/期限切れの記憶は送信対象にしていません。";

  return [
    {
      label: "AIに渡る",
      tone: pack.items.length > 0 || snippetCount > 0 ? "ready" : "attention",
      value: `${pack.items.length} 件の記憶 / ${snippetCount} snippets`,
      detail: `${clientName}へ渡るのは承認済みの記憶と最小snippetだけです。最高感度は${sensitivityBucketLabel(pack.maxSensitivityIncluded)}です。`
    },
    {
      label: "AIに渡らない",
      tone: pack.excludedItems.length > 0 ? "attention" : "ready",
      value: `${pack.excludedItems.length} exclusions`,
      detail: exclusionDetail
    },
    {
      label: "有効期限",
      tone: minutesLeft === null || minutesLeft > 0 ? "ready" : "attention",
      value: minutesLeft === null ? "短命Pack" : minutesLeft > 0 ? `約${minutesLeft}分` : "期限切れ",
      detail: "期限切れ後は外部AIが同じPack本文を再取得できません。"
    },
    {
      label: "確認状態",
      tone: deliveryState.canDeliver ? "ready" : "attention",
      value: deliveryState.expired ? "期限切れ" : packConfirmationLabel(pack.confirmationStatus),
      detail: deliveryState.expired
        ? "期限切れのため、外部AIへPack本文を返しません。"
        : deliveryState.canDeliver
          ? "承認済みのため、外部AIはこのPack境界内だけを取得できます。"
          : waitingDetail
    }
  ];
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  autoComplete
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  const inputId = useId();

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        type={type}
        autoComplete={autoComplete}
      />
    </div>
  );
}

function Textarea({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const textareaId = useId();

  return (
    <div className="field">
      <label htmlFor={textareaId}>{label}</label>
      <textarea
        id={textareaId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

export function isIsoExpired(value: string | null | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs;
}

export function effectiveRequestStatus(
  request: Pick<ContextPackRequest, "status" | "expiresAt">,
  nowMs = Date.now()
): ContextPackRequest["status"] {
  if (request.status !== "denied" && request.status !== "expired" && isIsoExpired(request.expiresAt, nowMs)) {
    return "expired";
  }
  return request.status;
}

export function contextPackDeliveryState(
  pack: Pick<ContextPack, "confirmationStatus" | "expiresAt">,
  request: Pick<ContextPackRequest, "status" | "expiresAt"> | null,
  nowMs = Date.now()
): ContextPackDeliveryState {
  const expired = isIsoExpired(pack.expiresAt ?? request?.expiresAt, nowMs);
  const confirmed = pack.confirmationStatus === "confirmed" || request?.status === "fulfilled";
  const requestStatus = request ? effectiveRequestStatus(request, nowMs) : null;
  const requiresApproval =
    pack.confirmationStatus === "pending_user_confirmation" ||
    pack.confirmationStatus === "edited_by_user";
  const closed =
    expired ||
    pack.confirmationStatus === "cancelled" ||
    requestStatus === "denied" ||
    requestStatus === "expired";
  const awaitingReturn = pack.confirmationStatus === "not_required" && requestStatus === "approved" && !closed;
  return {
    canDeliver: confirmed && !closed,
    closed,
    expired,
    confirmed,
    requiresApproval,
    awaitingReturn
  };
}

function packDeliveryTitle(state: ContextPackDeliveryState | null): string {
  if (state?.expired) return "期限切れのためAIへ返せません";
  if (state?.canDeliver) return "AIへ返せる状態です";
  if (state?.awaitingReturn) return "AIへ返す操作待ちです";
  return "AIへ返す前に確認が必要です";
}

function packDeliveryBody(state: ContextPackDeliveryState | null): string {
  if (state?.expired) {
    return "この短命のAIに渡す内容（記憶）は期限切れです。再度AIに渡す内容（記憶）を作成すると、現在のPolicyで確認できます。";
  }
  if (state?.canDeliver) {
    return "外部AIはget_request_statusで、このAIに渡す内容（記憶）だけを取得できます。";
  }
  if (state?.awaitingReturn) {
    return "確認不要ですが、返却またはコピーするまで外部AIにはPack本文を返しません。";
  }
  return "承認するまで、外部AIにはPack本文を返しません。";
}

function requestStatusLabel(status: ContextPackRequest["status"]): string {
  const labels: Record<ContextPackRequest["status"], string> = {
    draft: "下書き",
    pending_user_confirmation: "確認待ち",
    approved: "確認不要・未返却",
    denied: "拒否済み",
    fulfilled: "AI返却可",
    expired: "期限切れ"
  };
  return labels[status];
}

function requestNeedsUserAction(request: ContextPackRequest, nowMs = Date.now()): boolean {
  const status = effectiveRequestStatus(request, nowMs);
  return status === "pending_user_confirmation" || status === "approved";
}

function requestStatusTone(status: ContextPackRequest["status"]): "pending" | "ready" | "closed" | "neutral" {
  if (status === "pending_user_confirmation" || status === "approved") return "pending";
  if (status === "fulfilled") return "ready";
  if (status === "denied" || status === "expired") return "closed";
  return "neutral";
}

function packConfirmationLabel(status: ContextPack["confirmationStatus"]): string {
  const labels: Record<ContextPack["confirmationStatus"], string> = {
    not_required: "確認不要",
    pending_user_confirmation: "確認待ち",
    confirmed: "確認済み",
    edited_by_user: "編集済み",
    cancelled: "キャンセル"
  };
  return labels[status];
}

function exclusionReasonLabel(reason: ContextPack["excludedItems"][number]["reason"]): string {
  const labels: Record<ContextPack["excludedItems"][number]["reason"], string> = {
    sensitivity_policy: "感度ポリシーを超過",
    domain_policy: "領域ポリシー対象外",
    provider_policy: "AI接続ポリシーで制限",
    expired: "期限切れ",
    deleted: "削除済み",
    user_hidden: "ユーザ非表示",
    not_relevant: "今回の目的と不一致",
    secret_never_send: "非公開"
  };
  return labels[reason];
}

function sourceLifecycleLabel(state: VaultState["sources"][number]["deletionState"]): string {
  const labels: Record<VaultState["sources"][number]["deletionState"], string> = {
    active: "使用中",
    soft_deleted: "停止中",
    purged: "本文消去済み"
  };
  return labels[state];
}

function sourceLifecycleNotice(
  action: SourceLifecycleAction,
  affectedFactCount: number,
  invalidatedPackCount: number
): string {
  if (action === "restore") {
    return `Sourceを復元しました。${affectedFactCount}件の記憶を再びAIに渡す記憶に戻しました。`;
  }
  if (action === "purge_body") {
    return `Source本文を消去しました。${affectedFactCount}件の記憶を再確認待ちにし、${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
  }
  return `Sourceを使用停止しました。${affectedFactCount}件の記憶を再確認待ちにし、${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
}

type RestoreRecordCounts = RestorePreview["counts"];

export function makeRestorePreview(restored: VaultState, currentState: VaultState = createEmptyVault()): RestorePreview {
  const counts = vaultRecordCounts(restored);
  const currentCounts = vaultRecordCounts(currentState);
  const sourceBodyBytes = restored.sources.reduce((total, source) => total + textByteLength(source.body), 0);
  const activeConnectorCount = restored.connectorSessions.filter((session) =>
    ["available", "connected"].includes(session.status)
  ).length;
  const pairedConnectorCount = restored.connectorSessions.filter((session) =>
    session.status === "connected" || Boolean(session.oauthSubject || session.deviceId)
  ).length;
  const expiredCaptureCount = restored.passiveCaptureEvents.filter((event) =>
    event.processingStatus !== "purged" && hasDatePassed(event.retentionUntil)
  ).length;
  const promotedSourceCount = restored.sources.filter((source) => source.promotedToLongTerm).length;
  const aiBoundarySummary = restoreAiBoundarySummary(restored);
  const newestSourceAt = newestIso(restored.sources.map((source) => source.createdAt));
  const oldestAuditAt = oldestIso(restored.auditEvents.map((event) => event.occurredAt));
  const highestSensitivity = maxVaultSensitivity(restored);
  return {
    generatedAt: new Date().toISOString(),
    counts,
    currentCounts,
    sensitivitySummary: highestSensitivity ? sensitivityBucketLabel(highestSensitivity) : "空のVault",
    newestSourceAt,
    oldestAuditAt,
    sourceBodyBytes,
    activeConnectorCount,
    pairedConnectorCount,
    expiredCaptureCount,
    promotedSourceCount,
    receiptSections: restoreReceiptSections({
      counts,
      sourceBodyBytes,
      activeConnectorCount,
      pairedConnectorCount,
      expiredCaptureCount,
      promotedSourceCount,
      highestSensitivity
    }),
    aiBoundarySections: restoreAiBoundarySections(aiBoundarySummary),
    overwriteSections: restoreOverwriteSections(counts, currentCounts)
  };
}

function vaultRecordCounts(state: VaultState): RestoreRecordCounts {
  return {
    sources: state.sources.length,
    candidates: state.candidates.length,
    facts: state.facts.length,
    requests: state.contextPackRequests.length,
    packs: state.contextPacks.length,
    captureEvents: state.passiveCaptureEvents.length,
    connectorSessions: state.connectorSessions.length,
    policies: state.accessPolicies.length,
    auditEvents: state.auditEvents.length
  };
}

function restoreReceiptSections(input: {
  counts: RestoreRecordCounts;
  sourceBodyBytes: number;
  activeConnectorCount: number;
  pairedConnectorCount: number;
  expiredCaptureCount: number;
  promotedSourceCount: number;
  highestSensitivity: SensitivityTier | null;
}): RestorePreview["receiptSections"] {
  return [
    {
      label: "Source本文",
      value: `${input.counts.sources}件 / ${formatFileSize(input.sourceBodyBytes)}`,
      detail:
        input.promotedSourceCount > 0
          ? `${input.promotedSourceCount}件は長期保存Sourceです。復元しても自動でAIへ送信されません。`
          : "保存されたSource本文は復元されます。AIへ渡るのは承認済みのAIに渡す内容（記憶）だけです。",
      tone: input.counts.sources > 0 ? "attention" : "ready"
    },
    {
      label: "承認済みの記憶",
      value: `${input.counts.facts}件`,
      detail: "ユーザ承認済みの記憶として戻ります。確認待ちの記憶はInboxに残り、承認済みとしては使われません。",
      tone: input.counts.facts > 0 ? "ready" : "attention"
    },
    {
      label: "AI接続とPolicy",
      value: `${input.activeConnectorCount} active / ${input.counts.policies} policies`,
      detail:
        input.pairedConnectorCount > 0
          ? `${input.pairedConnectorCount}件のペアリング済み接続メタデータを含みます。復元後に接続状態を確認してください。`
          : "接続先ごとの許可範囲と感度上限を含みます。外部AIへ自動送信はしません。",
      tone: input.pairedConnectorCount > 0 ? "attention" : "ready"
    },
    {
      label: "Capture履歴",
      value: `${input.counts.captureEvents}件`,
      detail:
        input.expiredCaptureCount > 0
          ? `TTL切れCaptureが${input.expiredCaptureCount}件あります。復元後の整理対象です。`
          : "Passive Captureイベントを含みます。承認前の記憶はAI回答に使いません。",
      tone: input.expiredCaptureCount > 0 ? "attention" : "ready"
    },
    {
      label: "Auditレシート",
      value: `${input.counts.auditEvents}件`,
      detail:
        input.highestSensitivity === "secret_never_send"
          ? "最高感度に非公開データを含みます。AIに渡す内容（記憶）の境界とPolicyを確認してください。"
          : "AIに渡った事実の本文ではなく、配達先・件数・感度などの監査メタデータです。",
      tone: input.highestSensitivity === "secret_never_send" ? "attention" : "ready"
    }
  ];
}

function restoreAiBoundarySummary(state: VaultState): {
  deliverablePackCount: number;
  expiredPackCount: number;
  pendingRequestCount: number;
  pairedConnectorCount: number;
} {
  const requestsById = new Map(state.contextPackRequests.map((request) => [request.id, request]));
  const packStates = state.contextPacks.map((pack) =>
    contextPackDeliveryState(pack, pack.requestId ? requestsById.get(pack.requestId) ?? null : null)
  );
  return {
    deliverablePackCount: packStates.filter((packState) => packState.canDeliver).length,
    expiredPackCount: packStates.filter((packState) => packState.expired).length,
    pendingRequestCount: state.contextPackRequests.filter((request) => {
      const status = effectiveRequestStatus(request);
      return status === "pending_user_confirmation" || status === "approved";
    }).length,
    pairedConnectorCount: state.connectorSessions.filter((session) =>
      session.status === "connected" || Boolean(session.oauthSubject || session.deviceId)
    ).length
  };
}

function restoreAiBoundarySections(input: ReturnType<typeof restoreAiBoundarySummary>): RestorePreview["aiBoundarySections"] {
  return [
    {
      label: "取得可能Pack",
      value: `${input.deliverablePackCount}件`,
      detail:
        input.deliverablePackCount > 0
          ? "復元後も期限内の確認済みPackがあります。Requestsで内容と期限を確認してください。"
          : "復元後すぐ外部AIへ返せる内容（記憶）はありません。必要なら新しくAIに渡す内容（記憶）を作成します。",
      tone: input.deliverablePackCount > 0 ? "attention" : "ready"
    },
    {
      label: "期限切れPack",
      value: `${input.expiredPackCount}件`,
      detail:
        input.expiredPackCount > 0
          ? "期限切れPackは復元されても外部AIへ返せません。履歴としてRequests/Auditで確認できます。"
          : "短命Packの期限切れによる復元後の整理対象はありません。",
      tone: input.expiredPackCount > 0 ? "attention" : "ready"
    },
    {
      label: "確認/返却待ち",
      value: `${input.pendingRequestCount}件`,
      detail:
        input.pendingRequestCount > 0
          ? "復元後に確認待ちまたは返却待ちRequestがあります。送信前にRequestsで再確認してください。"
          : "復元後に即対応が必要なContext Requestはありません。",
      tone: input.pendingRequestCount > 0 ? "attention" : "ready"
    },
    {
      label: "AI接続メタデータ",
      value: `${input.pairedConnectorCount}件`,
      detail:
        input.pairedConnectorCount > 0
          ? "ペアリング済み接続メタデータを含みます。復元後にConnectionsで接続状態とPolicyを確認してください。"
          : "ペアリング済み接続メタデータは含まれていません。",
      tone: input.pairedConnectorCount > 0 ? "attention" : "ready"
    }
  ];
}

export function clearVaultImpactSections(state: VaultState): ClearImpactSection[] {
  const counts = vaultRecordCounts(state);
  const sourceBodyBytes = state.sources.reduce((total, source) => total + textByteLength(source.body), 0);
  const aiBoundary = restoreAiBoundarySummary(state);
  const hasSavedContext = counts.sources + counts.candidates + counts.facts > 0;
  const hasAiBoundaryRecords =
    counts.requests + counts.packs + aiBoundary.deliverablePackCount + aiBoundary.pendingRequestCount > 0;
  const hasConnectorPolicy = counts.connectorSessions + counts.policies > 0;
  const hasAuditCapture = counts.auditEvents + counts.captureEvents > 0;

  return [
    {
      label: "生活コンテキスト",
      value: `${counts.sources} Sources / ${counts.facts} Facts / ${counts.candidates} Inbox`,
      detail:
        sourceBodyBytes > 0
          ? `${formatFileSize(sourceBodyBytes)}のSource本文を含む保存データを削除します。本文内容はここには表示しません。`
          : "保存済みSource本文はありません。記憶とInboxの記憶も空になります。",
      tone: hasSavedContext ? "attention" : "ready"
    },
    {
      label: "AI境界",
      value: `${counts.requests} Requests / ${counts.packs} Packs`,
      detail:
        hasAiBoundaryRecords
          ? `${aiBoundary.deliverablePackCount}件の取得可能Pack、${aiBoundary.pendingRequestCount}件の確認/返却待ち、${aiBoundary.expiredPackCount}件の期限切れPackのローカル履歴を削除します。`
          : "AI要求とAIに渡した内容（記憶）はありません。",
      tone: hasAiBoundaryRecords ? "attention" : "ready"
    },
    {
      label: "AI接続とPolicy",
      value: `${counts.connectorSessions} Connections / ${counts.policies} Policies`,
      detail:
        hasConnectorPolicy
          ? `${aiBoundary.pairedConnectorCount}件のペアリング済み接続メタデータを含めて削除します。外部サービス側の設定は別途確認してください。`
          : "接続メタデータとPolicyはありません。",
      tone: hasConnectorPolicy ? "attention" : "ready"
    },
    {
      label: "Audit / Capture",
      value: `${counts.auditEvents} Audit / ${counts.captureEvents} Captures`,
      detail:
        hasAuditCapture
          ? "保存・承認・AI配達・Captureのローカル監査履歴を削除します。AIへ渡した過去の本文はAuditには保存されていません。"
          : "AuditとCapture履歴はありません。",
      tone: hasAuditCapture ? "attention" : "ready"
    }
  ];
}

function restoreOverwriteSections(
  nextCounts: RestoreRecordCounts,
  currentCounts: RestoreRecordCounts
): RestorePreview["overwriteSections"] {
  return [
    {
      label: "生活コンテキスト",
      value: `${currentCounts.sources} Sources / ${currentCounts.facts} Facts -> ${nextCounts.sources} Sources / ${nextCounts.facts} Facts`,
      detail: "現在のSource、記憶、Inboxの記憶はバックアップ側の内容へ置き換わります。",
      tone: currentCounts.sources + currentCounts.facts > 0 ? "attention" : "ready"
    },
    {
      label: "Context Requests",
      value: `${currentCounts.requests} Requests / ${currentCounts.packs} Packs -> ${nextCounts.requests} Requests / ${nextCounts.packs} Packs`,
      detail: "確認待ちRequest、生成済みPack、TTL情報もバックアップ側へ戻ります。",
      tone: currentCounts.requests + currentCounts.packs > 0 ? "attention" : "ready"
    },
    {
      label: "AI接続設定",
      value: `${currentCounts.connectorSessions} Connections / ${currentCounts.policies} Policies -> ${nextCounts.connectorSessions} Connections / ${nextCounts.policies} Policies`,
      detail: "Claude、ChatGPT、ブラウザCapture、コピーFallbackの接続メタデータとPolicyが置き換わります。",
      tone: "attention"
    },
    {
      label: "監査とCapture",
      value: `${currentCounts.auditEvents} Audit / ${currentCounts.captureEvents} Captures -> ${nextCounts.auditEvents} Audit / ${nextCounts.captureEvents} Captures`,
      detail: "何を保存したか、どのAIへ渡したかの履歴もバックアップ側の履歴に置き換わります。",
      tone: currentCounts.auditEvents + currentCounts.captureEvents > 0 ? "attention" : "ready"
    }
  ];
}

function newestIso(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function oldestIso(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function hasDatePassed(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function textByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function maxVaultSensitivity(state: VaultState): SensitivityTier | null {
  const values: SensitivityTier[] = [
    ...state.sources.map((source) => source.defaultSensitivity),
    ...state.candidates.map((candidate) => candidate.detectedSensitivity),
    ...state.facts.map((fact) => fact.sensitivity),
    ...state.passiveCaptureEvents.map((event) => event.sensitivityGuess),
    ...state.contextPacks.map((pack) => pack.maxSensitivityIncluded)
  ];
  if (values.length === 0) return null;
  const order: SensitivityTier[] = [
    "public",
    "personal",
    "private_consequential",
    "sensitive",
    "secret_never_send"
  ];
  return values.reduce((max, current) =>
    order.indexOf(current) > order.indexOf(max) ? current : max
  );
}

function isLocalhostUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return value.includes("localhost") || value.includes("127.0.0.1");
  }
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isLocalhostUrl(value);
  } catch {
    return false;
  }
}

function passiveCaptureSourceId(event: PassiveCaptureEvent): string | null {
  if (event.sourceId) return event.sourceId;
  const [sourceId] = event.textFragmentRef.split(":");
  return sourceId || null;
}

function passiveCaptureSourceIds(state: VaultState): string[] {
  return passiveCaptureSourceIdsForEvents(state.passiveCaptureEvents, state.sources);
}

function passiveCaptureSourceIdsForEvents(
  events: PassiveCaptureEvent[],
  sources: VaultState["sources"]
): string[] {
  const sourceIds = new Set<string>();
  for (const event of events) {
    const sourceId = passiveCaptureSourceId(event);
    const source = sourceId ? sources.find((item) => item.id === sourceId) : undefined;
    if (source?.origin === "passive_browser" && source.deletionState !== "purged") {
      sourceIds.add(source.id);
    }
  }
  return [...sourceIds];
}

export function homeCaptureSafetySummary(
  settings: PassiveCaptureSettings,
  events: PassiveCaptureEvent[],
  sources: VaultState["sources"]
): HomeCaptureSafetySummary {
  const purgeableCount = passiveCaptureSourceIdsForEvents(events, sources).length;
  const [lastEvent] = [...events].sort(
    (left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt)
  );
  const lastSourceId = lastEvent ? passiveCaptureSourceId(lastEvent) : null;
  const lastSource = lastSourceId ? sources.find((source) => source.id === lastSourceId) : undefined;
  const allowedSitesLabel = captureAllowedSitesLabel(settings.allowedSites);
  const lastCaptureLabel = lastEvent ? formatDateTime(lastEvent.capturedAt) : "まだありません";
  const lastPreview = lastEvent ? compactHomeCapturePreview(capturePreviewText(lastSource)) : null;

  if (settings.enabled) {
    return {
      tone: "ready",
      title: "許可サイトだけをローカルで記憶化中",
      body:
        "Captureは確認待ちの記憶を作るだけです。承認とAI送信は、Memory InboxとAIに渡した内容（記憶）の確認を通ります。",
      allowedSitesLabel,
      lastCaptureLabel,
      lastPreview,
      purgeableCount
    };
  }

  return {
    tone: "attention",
    title: "Passive Captureは停止中",
    body:
      "停止中はブラウザ拡張や手動Captureから書き込みません。必要なときだけ開始できます。",
    allowedSitesLabel,
    lastCaptureLabel,
    lastPreview,
    purgeableCount
  };
}

function captureAllowedSitesLabel(sites: string[]): string {
  if (sites.length === 0) return "未設定";
  if (sites.length <= 2) return sites.join(", ");
  return `${sites.slice(0, 2).join(", ")} +${sites.length - 2}`;
}

function compactHomeCapturePreview(value: string): string {
  return value.length > 84 ? `${value.slice(0, 84)}...` : value;
}

function connectorKindLabel(kind: ConnectorKind): string {
  const labels: Record<ConnectorKind, string> = {
    claude_desktop: "Claude Desktop",
    chatgpt: "ChatGPT",
    claude_remote: "Claude",
    gemini: "Gemini",
    codex: "Codex",
    generic_mcp: "MCP client",
    copy_fallback: "Copy fallback"
  };
  return labels[kind];
}

function capturePreviewText(source?: VaultState["sources"][number]): string {
  if (!source) return "紐づくSourceが見つかりません。";
  if (source.deletionState === "purged") return "本文は消去済みです。記憶は確認待ちになります。";
  const text = source.body.replace(/\s+/g, " ").trim();
  if (!text) return "本文は空です。";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function captureEventStatusLabel(
  event: PassiveCaptureEvent,
  source?: VaultState["sources"][number]
): string {
  if (source?.deletionState === "purged" || event.processingStatus === "purged") return "本文消去済み";
  if (event.processingStatus === "candidate_generated") return "記憶作成";
  if (event.processingStatus === "captured") return "取得済み";
  return "記憶なし";
}

function sourceMetadataNotice(invalidatedPackCount: number): string {
  return `Sourceを更新しました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
}

function sourceBodyNotice(
  candidateCount: number,
  affectedFactCount: number,
  invalidatedPackCount: number
): string {
  return `Source本文を保存し、${candidateCount}件の記憶を再生成しました。${affectedFactCount}件の記憶を再確認待ちにし、${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
}

function unsupportedFileFeedback(
  file: Pick<File, "name" | "size">,
  reason: "too_large" | "native_required" | "ocr_required" | "legacy_office" | "unsupported_type"
): UploadFeedback {
  if (reason === "too_large") {
    return {
      tone: "attention",
      title: "ファイルが大きすぎます",
      body: `${file.name} は ${formatFileSize(file.size)} です。テキストSourceは ${formatFileSize(MAX_TEXT_SOURCE_BYTES)} まで、PDF/Officeのローカル抽出は ${formatFileSize(MAX_NATIVE_DOCUMENT_SOURCE_BYTES)} までです。`
    };
  }
  if (reason === "native_required") {
    return {
      tone: "attention",
      title: "Desktop appで開いてください",
      body: `${file.name} はPDF/Office抽出が必要です。ブラウザPreviewではSource化せず、Desktop appのローカルVault Coreで抽出してください。`
    };
  }
  if (reason === "ocr_required") {
    return {
      tone: "attention",
      title: "画像OCRはまだ未接続です",
      body: `${file.name} は画像として検出しました。SettingsのLocal OCRで検出機能を使うか、ローカルOCRコマンドを設定するまでは、テキスト化した内容をManual sourceに貼り付けてください。`
    };
  }
  if (reason === "legacy_office") {
    return {
      tone: "attention",
      title: "旧Office変換はまだ未接続です",
      body: `${file.name} は旧Officeバイナリ形式です。SettingsのLegacy Office conversionでLibreOffice等を設定するか、DOCX/PPTX/XLSX、PDF、またはテキストへ変換してから追加してください。`
    };
  }
  return {
    tone: "attention",
    title: "まだ対応していない形式です",
    body: `${file.name} はSource化しませんでした。対応形式は ${SUPPORTED_SOURCE_LABEL} です。`
  };
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 32 * 1024;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
  }
  return btoa(binary);
}

function documentExtractionLabel(kind: string): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "docx":
      return "DOCX";
    case "pptx":
      return "PPTX";
    case "xlsx":
      return "XLSX";
    case "opendocument":
      return "OpenDocument";
    case "image_ocr":
      return "画像OCR";
    case "legacy_office_converted":
      return "旧Office変換済み文書";
    case "text":
      return "テキスト";
    default:
      return "文書";
  }
}

function sourceAcceptForCapabilities(
  ocrExtractionAvailable: boolean,
  legacyOfficeConversionAvailable: boolean
): string {
  if (!legacyOfficeConversionAvailable) {
    return ocrExtractionAvailable ? SUPPORTED_SOURCE_ACCEPT_WITH_OCR : SUPPORTED_SOURCE_ACCEPT;
  }
  return [
    ...SUPPORTED_TEXT_SOURCE_EXTENSIONS,
    ...SUPPORTED_NATIVE_DOCUMENT_EXTENSIONS,
    ...LEGACY_OFFICE_EXTENSIONS,
    ...(ocrExtractionAvailable ? OCR_DOCUMENT_EXTENSIONS : [])
  ].join(",");
}

function sourceLabelForCapabilities(
  ocrExtractionAvailable: boolean,
  legacyOfficeConversionAvailable: boolean
): string {
  if (ocrExtractionAvailable && legacyOfficeConversionAvailable) {
    return "TXT, PDF, Office, OpenDocument, Images";
  }
  if (ocrExtractionAvailable) return SUPPORTED_SOURCE_LABEL_WITH_OCR;
  if (legacyOfficeConversionAvailable) return "TXT, PDF, Office, OpenDocument";
  return SUPPORTED_SOURCE_LABEL;
}

export function documentIngestionReadiness(
  ocrExtractionAvailable: boolean,
  ocrProviderLabel: string | null,
  legacyOfficeConversionAvailable: boolean,
  legacyOfficeProviderLabel: string | null
): DocumentIngestionReadinessItem[] {
  return [
    {
      label: "PDF / DOCX等",
      state: "ready",
      value: "Desktopでローカル抽出",
      detail: "本文はSourceとInboxの記憶になり、承認とAI送信は別確認です。"
    },
    {
      label: "画像OCR",
      state: ocrExtractionAvailable ? "ready" : "attention",
      value: ocrExtractionAvailable ? `${ocrProviderLabel ?? "OCR Provider"} 接続済み` : "Provider未接続",
      detail: ocrExtractionAvailable
        ? "画像はこの端末のOCRだけで抽出します。"
        : "画像はSource化せず、SettingsでLocal OCRを設定するまで手入力を使います。"
    },
    {
      label: "旧DOC / XLS / PPT",
      state: legacyOfficeConversionAvailable ? "ready" : "attention",
      value: legacyOfficeConversionAvailable
        ? `${legacyOfficeProviderLabel ?? "Legacy Office Provider"} 接続済み`
        : "変換Provider未接続",
      detail: legacyOfficeConversionAvailable
        ? "旧Officeはこの端末で新形式へ変換してから抽出します。"
        : "旧OfficeはSource化せず、SettingsでLibreOffice等を設定してから追加します。"
    }
  ];
}

function normalizedOcrTimeout(value: number, defaultValue = 30): number {
  if (!Number.isFinite(value)) return defaultValue;
  return Math.min(120, Math.max(1, Math.round(value)));
}

function ocrProviderLabelFromCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "OCR Provider";
  return trimmed.split(/[\\/]/).filter(Boolean).pop() ?? trimmed;
}

type OcrInstallGuide = {
  id: string;
  label: string;
  description: string;
  installCommand: string;
  command: string;
  args: string;
};

function ocrInstallerGuidesForPlatform(): OcrInstallGuide[] {
  const guides: OcrInstallGuide[] = [
    {
      id: "mac_homebrew",
      label: "macOS / Homebrew",
      description: "HomebrewでTesseract本体と言語データを入れます。インストール後は検出機能を使うのが安全です。",
      installCommand: "brew install tesseract tesseract-lang",
      command: "/opt/homebrew/bin/tesseract",
      args: "{input} stdout -l jpn+eng"
    },
    {
      id: "windows_winget",
      label: "Windows / winget",
      description: "Windowsの標準パッケージ管理でTesseractを入れます。インストール先が違う場合はCommandを修正してください。",
      installCommand: "winget install --id UB-Mannheim.TesseractOCR",
      command: "C:\\Program Files\\Tesseract-OCR\\tesseract.exe",
      args: "{input} stdout -l jpn+eng"
    },
    {
      id: "linux_apt",
      label: "Ubuntu / apt",
      description: "Ubuntu系Linux向けです。日本語と英語の言語データも一緒に入れます。",
      installCommand: "sudo apt install tesseract-ocr tesseract-ocr-jpn tesseract-ocr-eng",
      command: "/usr/bin/tesseract",
      args: "{input} stdout -l jpn+eng"
    }
  ];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  const preferredId = platform.includes("win")
    ? "windows_winget"
    : platform.includes("linux")
      ? "linux_apt"
      : platform.includes("mac")
        ? "mac_homebrew"
        : "";
  if (!preferredId) return guides;
  return [
    ...guides.filter((guide) => guide.id === preferredId),
    ...guides.filter((guide) => guide.id !== preferredId)
  ];
}

function legacyOfficeInstallGuidesForPlatform(): OcrInstallGuide[] {
  const args = "--headless --convert-to {target_ext} --outdir {output_dir} {input}";
  const guides: OcrInstallGuide[] = [
    {
      id: "mac_libreoffice",
      label: "macOS / Homebrew",
      description: "LibreOfficeを入れて、旧OfficeをDOCX/PPTX/XLSXへローカル変換します。",
      installCommand: "brew install --cask libreoffice",
      command: "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      args
    },
    {
      id: "windows_libreoffice",
      label: "Windows / winget",
      description: "LibreOfficeを入れます。インストール先が違う場合はCommandを修正してください。",
      installCommand: "winget install --id TheDocumentFoundation.LibreOffice",
      command: "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      args
    },
    {
      id: "linux_libreoffice",
      label: "Ubuntu / apt",
      description: "Ubuntu系Linux向けです。headless変換で旧Officeを新形式へ変換します。",
      installCommand: "sudo apt install libreoffice",
      command: "/usr/bin/libreoffice",
      args
    }
  ];
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase();
  const preferredId = platform.includes("win")
    ? "windows_libreoffice"
    : platform.includes("linux")
      ? "linux_libreoffice"
      : platform.includes("mac")
        ? "mac_libreoffice"
        : "";
  if (!preferredId) return guides;
  return [
    ...guides.filter((guide) => guide.id === preferredId),
    ...guides.filter((guide) => guide.id !== preferredId)
  ];
}

function linkedFactCount(state: VaultState, sourceId: string): number {
  return state.facts.filter((fact) => fact.sourceIds.includes(sourceId)).length;
}

function activeLinkedFactCount(state: VaultState, sourceId: string): number {
  return state.facts.filter((fact) => fact.status === "active" && fact.sourceIds.includes(sourceId)).length;
}

function activeSourcePackCount(state: VaultState, sourceId: string): number {
  const linkedFactIds = new Set(
    state.facts.filter((fact) => fact.sourceIds.includes(sourceId)).map((fact) => fact.id)
  );
  return state.contextPacks.filter(
    (pack) =>
      pack.confirmationStatus !== "cancelled" &&
      pack.items.some((item) => linkedFactIds.has(item.factId))
  ).length;
}

function sourceRetentionLabel(source: VaultState["sources"][number]): string | null {
  if (source.promotedToLongTerm) return "長期保持";
  if (source.retentionUntil) return `TTL ${new Date(source.retentionUntil).toLocaleDateString()}`;
  return null;
}

function factStatusLabel(status: ApprovedFact["status"]): string {
  const labels: Record<ApprovedFact["status"], string> = {
    active: "使用中",
    superseded: "置き換え済み",
    expired: "期限切れ",
    needs_review: "再確認待ち",
    user_hidden: "非表示",
    deleted: "削除済み"
  };
  return labels[status];
}

function factLifecycleNotice(action: FactLifecycleAction, invalidatedPackCount: number): string {
  if (action === "keep_active" || action === "restore") {
    return "記憶を保持し、AIに渡す記憶へ戻しました。";
  }
  if (action === "hide") {
    return `記憶をAIに渡す記憶から非表示にしました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
  }
  if (action === "delete") {
    return `記憶を削除済みにしました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
  }
  return `記憶を再確認待ちにしました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
}

function factMetadataNotice(invalidatedPackCount: number): string {
  return `記憶を更新しました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
}

function candidateApprovalNotice(supersededFactCount: number, invalidatedPackCount: number): string {
  if (supersededFactCount > 0) {
    return `新しい記憶として保存し、${supersededFactCount}件の古い記憶を置き換えました。${invalidatedPackCount}件のAIに渡した内容（記憶）を無効化しました。`;
  }
  return "承認済みの記憶として保存しました。AIへ渡るのはAIに渡す内容（記憶）の確認後だけです。";
}

function activeFactPackCount(state: VaultState, factId: string): number {
  return state.contextPacks.filter((pack) =>
    pack.confirmationStatus !== "cancelled" && pack.items.some((item) => item.factId === factId)
  ).length;
}

function packsForFacts(state: VaultState, factIds: string[]): ContextPack[] {
  const factIdSet = new Set(factIds);
  if (factIdSet.size === 0) return [];
  return state.contextPacks.filter(
    (pack) =>
      pack.confirmationStatus !== "cancelled" &&
      pack.items.some((item) => factIdSet.has(item.factId))
  );
}

function toggleSelectedId(selectedIds: string[], id: string): string[] {
  return selectedIds.includes(id)
    ? selectedIds.filter((selectedId) => selectedId !== id)
    : [...selectedIds, id];
}

function searchModeCopy(
  mode: SearchMode,
  hasNativeVault: boolean
): { title: string; body: string; tone: "ready" | "attention" } {
  if (mode === "native_fts") {
    return {
      title: "Vault Core FTSで検索中",
      body: "暗号化SQLiteの記憶だけを検索します。確認待ちの記憶とRaw Source本文は結果に含めません。",
      tone: "ready"
    };
  }
  if (mode === "loading") {
    return {
      title: "Vault Core FTSを更新中",
      body: "最新の記憶索引を読み込んでいます。",
      tone: "attention"
    };
  }
  return {
    title: hasNativeVault ? "ブラウザ内検索へフォールバック中" : "ブラウザ内検索",
    body: hasNativeVault
      ? "ネイティブ検索に失敗したため、同期済みのローカル状態から記憶だけを検索します。"
      : "Tauri外ではブラウザ内の同期済み状態から記憶だけを検索します。",
    tone: "attention"
  };
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatUnixSeconds(value: number | null | undefined): string {
  if (!value) return "なし";
  return formatDateTime(new Date(value * 1000).toISOString());
}

function isLikelyChromeExtensionId(value: string): boolean {
  return /^[a-p]{32}$/.test(value.trim().toLowerCase());
}

function makeCaptureSetupCommand(extensionId: string): string {
  const normalized = extensionId.trim().toLowerCase();
  const id = isLikelyChromeExtensionId(normalized)
    ? normalized
    : "<Chrome extension id>";
  return `npm run capture:build\nLCV_EXTENSION_ID=${id} npm run extension:host-manifest`;
}

function titleForView(view: View): string {
  return {
    home: "Life Context Home",
    sources: "Sources",
    connections: "AI Connections",
    requests: "Context Requests",
    search: "Search",
    audit: "Audit",
    settings: "Settings"
  }[view];
}

function makeClaudeDesktopConfig(nativePath: string | null): string {
  return JSON.stringify(
    {
      mcpServers: {
        "life-context-vault": {
          type: "stdio",
          command: localMcpBinaryPath,
          env: {
            LCV_VAULT_DB_PATH:
              nativePath ?? "$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3"
          }
        }
      }
    },
    null,
    2
  );
}

function mergeVaultStates(externalState: VaultState, localState: VaultState): VaultState {
  return {
    ...externalState,
    ...localState,
    sources: mergeById(externalState.sources, localState.sources),
    candidates: mergeById(externalState.candidates, localState.candidates),
    facts: mergeById(externalState.facts, localState.facts),
    accessPolicies: mergeById(externalState.accessPolicies, localState.accessPolicies),
    passiveCaptureSettings: localState.passiveCaptureSettings,
    passiveCaptureEvents: mergeById(
      externalState.passiveCaptureEvents,
      localState.passiveCaptureEvents
    ),
    connectorSessions: mergeById(externalState.connectorSessions, localState.connectorSessions),
    contextPackRequests: mergeById(
      externalState.contextPackRequests,
      localState.contextPackRequests
    ),
    contextPacks: mergeById(externalState.contextPacks, localState.contextPacks),
    auditEvents: mergeById(externalState.auditEvents, localState.auditEvents)
  };
}

function mergeById<T extends { id: string }>(externalItems: T[], localItems: T[]): T[] {
  const merged = new Map<string, T>();
  for (const item of externalItems) {
    merged.set(item.id, item);
  }
  for (const item of localItems) {
    merged.set(item.id, item);
  }
  return Array.from(merged.values());
}

function groupByDomain(facts: ApprovedFact[]): Partial<Record<LifeContextDomain, ApprovedFact[]>> {
  return facts.reduce<Partial<Record<LifeContextDomain, ApprovedFact[]>>>((acc, fact) => {
    acc[fact.domain] = [...(acc[fact.domain] ?? []), fact];
    return acc;
  }, {});
}
