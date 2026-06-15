import {
  Activity,
  Archive,
  ArrowRight,
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
  saveNativeRuntimePreferences
} from "./nativeStorage";
import { detectLang, Lang, t } from "./i18n";
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
  backgroundSetupBody,
  buildContextPackForRequest,
  canSendContextPackToAi,
  confirmContextPack,
  createContextPackRequest,
  createBackgroundSource,
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
  BackgroundSetupInput,
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
  | "inbox"
  | "sources"
  | "connections"
  | "requests"
  | "search"
  | "settings";

type ConnectionDiagnosticTone = "ready" | "attention" | "blocked" | "neutral";

type ConnectionDiagnosticAction =
  | "open_desktop"
  | "start_ai_access"
  | "start_hosted_agent"
  | "copy_web_connector"
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

interface HostedRelayRegistrationReadiness {
  tone: ConnectionDiagnosticTone;
  title: string;
  summary: string;
  nextStep: string;
  items: ConnectionDiagnosticItem[];
}

interface WebAiRegistrationGuide {
  provider: string;
  status: ConnectionDiagnosticState;
  statusLabel: string;
  steps: string[];
  actionLabel: string;
  boundary: string;
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

type OnboardingStep = {
  title: string;
  body: string;
  status: "done" | "current" | "blocked";
  actionLabel: string;
  action?: () => void;
  disabled?: boolean;
};

type HomeNextActionKind =
  | "review_candidates"
  | "add_background"
  | "review_pending_request"
  | "try_context_pack"
  | "connect_ai";

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

const blankSetup: BackgroundSetupInput = {
  displayName: "",
  tonePreference: "",
  activeLifeAreas: "",
  recurringConstraints: "",
  confirmationTopics: ""
};

const localMcpBinaryPath = "/Users/kota/Documents/My Context/src-tauri/target/release/lcv-mcp";
const localAgentBinaryPath = "/Users/kota/Documents/My Context/src-tauri/target/release/lcv-agent";
const localRelayBaseUrl = "http://127.0.0.1:8765";
const localRelayUrl = `${localRelayBaseUrl}/mcp`;
const localRelayToken = "dev-local-token";

export function App() {
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
  const [setup, setSetup] = useState<BackgroundSetupInput>(blankSetup);
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
                  lastError: error instanceof Error ? error.message : "Login item status failed"
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
        setSearchError(error instanceof Error ? error.message : "Native search failed");
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

  async function submitBackground() {
    const body = backgroundSetupBody(setup);
    if (!body.trim()) {
      setNotice("背景情報を1つ以上入力してください。");
      return;
    }
    const addStatus = await addSourceThroughCore(
      {
        kind: "background_onboarding",
        origin: "guided_onboarding",
        title: "Guided background setup",
        body
      },
      "背景Sourceを保存し、Memory Inboxに候補を追加しました。"
    );
    if (addStatus === "unavailable") {
      const next = createBackgroundSource(state, setup);
      apply(next, "背景Sourceを保存し、Memory Inboxに候補を追加しました。");
      setView("inbox");
    }
    if (addStatus === "failed") return;
    setSetup(blankSetup);
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
      "Sourceを保存し、Memory Inboxに候補を追加しました。"
    );
    if (addStatus === "unavailable") {
      const next = addSourceWithCandidates(state, {
        kind: "manual_note",
        origin: "manual_entry",
        title: manualTitle || "Manual note",
        body: manualBody
      });
      apply(next, "Sourceを保存し、Memory Inboxに候補を追加しました。");
      setView("inbox");
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
          setNotice(error instanceof Error ? error.message : "保留中Sourceの保存に失敗しました。");
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
      `${file.name} をSourceとして保存し、Memory Inboxに候補を追加しました。${extractionDetail}`
    );
    if (addStatus === "unavailable") {
      const next = addSourceWithCandidates(state, {
        kind: "document",
        origin: "user_upload",
        title: file.name,
        body: text
      });
      apply(next, `${file.name} をSourceとして保存し、Memory Inboxに候補を追加しました。${extractionDetail}`);
      setView("inbox");
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
        `${message} ${added.candidateIds.length}件の候補が作成されました。承認されるまでAIには使われません。`
      );
      setView("inbox");
      return "saved";
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Vault CoreでSourceを保存できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでSourceを更新できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでCapture本文を消去できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでSourceを保存できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでSource本文を保存できませんでした。");
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
      setNotice("Factが見つかりませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでFactを更新できませんでした。");
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
      setNotice("Factが見つかりませんでした。");
      return false;
    }
    if (!input.factText.trim()) {
      setNotice("Fact本文を入力してください。");
      return false;
    }
    if (input.sensitivity === "secret_never_send") {
      setNotice("SecretはApprovedFactとして保存できません。Sourceまたは候補を削除してください。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでFactを保存できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault Coreで候補を承認できませんでした。");
        return;
      }
    }
    if (candidate.sourceIds.some((sourceId) => state.sources.find((source) => source.id === sourceId)?.deletionState !== "active")) {
      setNotice("削除または消去されたSource由来の候補はFact化できません。Sourceを復元するか、新しいSourceとして追加してください。");
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
        setNotice(error instanceof Error ? error.message : "Vault Coreで候補を更新できませんでした。");
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
          setNotice("Vault CoreでContext Requestを受け取り、短命Context Packを生成しました。");
          setActiveRequestId(built.requestId);
          setActivePackId(built.packId);
          return;
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Vault CoreでContext Packを生成できませんでした。");
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
    apply(built.state, "Context Requestを受け取り、短命Context Packを生成しました。");
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
    const verb = included ? "Context Packへ戻しました。" : "このAIには渡さないようContext Packから外しました。";
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでContext Packを更新できませんでした。");
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
        setNotice("このContext Packは現在のAI接続ポリシーでは送信できません。新しいContext Packを作成してください。");
        return;
      }
      setNotice("このContext PackはすでにAIへ返せる状態です。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
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
          setNotice("Context Packを承認しました。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
          return;
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Vault CoreでContext Packを承認できませんでした。");
        return;
      }
    }
    const confirmedState = confirmContextPack(state, pack.id);
    const confirmedPack = confirmedState.contextPacks.find((item) => item.id === pack.id);
    if (!confirmedPack || !canSendContextPackToAi(confirmedState, confirmedPack)) {
      apply(
        confirmedState,
        "このContext Packは現在のAI接続ポリシーでは承認できません。新しいContext Packを作成してください。"
      );
      return;
    }
    apply(confirmedState, "Context Packを承認しました。Claude Desktop等のMCPクライアントは get_request_status で取得できます。");
  }

  async function copyPackForAi(pack: ContextPack) {
    const request = pack.requestId
      ? state.contextPackRequests.find((item) => item.id === pack.requestId)
      : null;
    const shouldConfirm = pack.confirmationStatus !== "confirmed" || request?.status !== "fulfilled";
    if (!shouldConfirm && !canSendContextPackToAi(state, pack)) {
      setNotice("このContext Packは現在のAI接続ポリシーではコピーできません。新しいContext Packを作成してください。");
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
              setNotice("このContext Packは現在のAI接続ポリシーではコピーできません。新しいContext Packを作成してください。");
              return;
            }
          }
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Vault CoreでContext Packを承認できませんでした。");
          return;
        }
      } else {
        const confirmedState = confirmContextPack(state, pack.id);
        const confirmedPack = confirmedState.contextPacks.find((item) => item.id === pack.id);
        if (!confirmedPack || !canSendContextPackToAi(confirmedState, confirmedPack)) {
          setState(confirmedState);
          setNotice("このContext Packは現在のAI接続ポリシーではコピーできません。新しいContext Packを作成してください。");
          return;
        }
        setState(confirmedState);
        payloadPack = confirmedPack;
      }
    }
    const payloadText = JSON.stringify(makeAiContextPackPayload(payloadPack), null, 2);
    const copied = await copyText(
      payloadText,
      shouldConfirm
        ? "Context Packを承認し、AI向けペイロードをコピーしました。"
        : "AI向けContext Packをコピーしました。"
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
      setNotice("このContext Packは現在のAI接続ポリシーでは記録できません。新しいContext Packを作成してください。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでContext Requestを拒否できませんでした。");
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
        setNotice(error instanceof Error ? error.message : "Vault CoreでAI接続ポリシーを保存できませんでした。");
        return;
      }
    }
    apply(updateAccessPolicy(state, clientId, settings), "AI接続ポリシーを更新しました。");
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
      setNotice(error instanceof Error ? error.message : "バックアップに失敗しました。");
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
      setNotice(error instanceof Error ? error.message : "バックアップの読み取りに失敗しました。");
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
      setNotice(error instanceof Error ? error.message : "復元に失敗しました。");
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
      setNotice(error instanceof Error ? error.message : "Native Vaultの再読み込みに失敗しました。");
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

  async function refreshLoginItem() {
    try {
      const status = await getLoginItemStatus();
      setLoginItemStatus(status);
      setNotice(status ? "Login Itemの状態を更新しました。" : "Desktop appでのみLogin Itemを管理できます。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Login Itemの状態確認に失敗しました。");
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
      setNotice(error instanceof Error ? error.message : "Login Itemの有効化に失敗しました。");
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
      setNotice(error instanceof Error ? error.message : "Login Itemの無効化に失敗しました。");
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
        setNotice("Claude Desktop設定はすでに最新です。");
      } else {
        setNotice("Claude Desktop設定へLife Context Vaultを追加しました。Claude Desktopを再起動してください。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Claude Desktop設定のインストールに失敗しました。");
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LC</div>
          <div>
            <h1>Life Context Vault</h1>
            <p>Control Center</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Primary">
          <NavButton icon={<Home size={18} />} label={t(lang, "nav.home")} ariaLabel={t(lang, "nav.home")} active={view === "home"} onClick={() => setView("home")} />
          <NavButton icon={<Inbox size={18} />} label={t(lang, "nav.inbox")} ariaLabel={t(lang, "nav.inbox")} active={view === "inbox"} onClick={() => setView("inbox")} badge={activeCandidates.length} />
          <NavButton icon={<FileText size={18} />} label={t(lang, "nav.sources")} ariaLabel={t(lang, "nav.sources")} active={view === "sources"} onClick={() => setView("sources")} />
          <NavButton icon={<Plug size={18} />} label={t(lang, "nav.connections")} ariaLabel={t(lang, "nav.connections")} active={view === "connections"} onClick={() => setView("connections")} />
          <NavButton
            icon={<MessageSquare size={18} />}
            label={t(lang, "nav.requests")}
            ariaLabel={t(lang, "nav.requests")}
            active={view === "requests"}
            onClick={() => setView("requests")}
            badge={state.contextPackRequests.filter((request) => requestNeedsUserAction(request)).length}
          />
          <NavButton icon={<Search size={18} />} label={t(lang, "nav.search")} ariaLabel={t(lang, "nav.search")} active={view === "search"} onClick={() => setView("search")} badge={reviewFacts.length} />
          <NavButton icon={<Settings size={18} />} label={t(lang, "nav.settings")} ariaLabel={t(lang, "nav.settings")} active={view === "settings"} onClick={() => setView("settings")} />
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === "ja" ? "en" : "ja")}
            aria-label="Toggle language"
            title={lang === "ja" ? "Switch to English" : "日本語に切り替え"}
            type="button"
          >
            {lang.toUpperCase()}
          </button>
        </nav>
        <div className="sidebar-stats">
          <Metric label="元データ" value={state.sources.length} />
          <Metric label="Fact" value={activeFacts.length} />
          <Metric label="依頼" value={state.contextPackRequests.length} />
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">User-owned life context</p>
            <h2>{titleForView(view)}</h2>
          </div>
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
          <HomeView
            facts={activeFacts}
            candidates={activeCandidates}
            connectors={state.connectorSessions}
            sources={state.sources}
            requests={state.contextPackRequests}
            contextPacks={state.contextPacks}
            nativePath={nativePath}
            setup={setup}
            setSetup={setSetup}
            submitBackground={submitBackground}
            seedDemo={seedDemo}
            goInbox={() => setView("inbox")}
            goSources={() => setView("sources")}
            goRequests={() => setView("requests")}
            goConnections={() => setView("connections")}
          />
        )}
        {view === "inbox" && (
          <InboxView
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
            reject={(candidate) => void reviewCandidateStatus(candidate, "rejected", "候補を却下しました。")}
            archive={(candidate) => void reviewCandidateStatus(candidate, "archived", "候補をLaterに移しました。")}
            markSensitive={(candidate) =>
              void reviewCandidateStatus(candidate, "blocked_sensitive", "候補をセンシティブ扱いにしました。")
            }
            goHome={() => setView("home")}
            goSources={() => setView("sources")}
            goConnections={() => setView("connections")}
          />
        )}
        {view === "sources" && (
          <SourcesView
            sources={state.sources}
            candidates={state.candidates}
            facts={state.facts}
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
            goInbox={() => setView("inbox")}
          />
        )}
        {view === "connections" && (
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
            goInbox={() => setView("inbox")}
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
            copyText={copyText}
          />
        )}
      </main>
    </div>
  );
}

function NavButton({
  icon,
  label,
  ariaLabel,
  active,
  onClick,
  badge
}: {
  icon: React.ReactNode;
  label: string;
  ariaLabel?: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      aria-label={ariaLabel ?? label}
      aria-current={active ? "page" : undefined}
      className={active ? "nav-item active" : "nav-item"}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
      {badge ? <strong>{badge}</strong> : null}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong><span className="sr-only">: </span>{value}</strong>
    </div>
  );
}

export function HomeView({
  facts,
  candidates,
  connectors,
  sources,
  requests,
  contextPacks,
  nativePath,
  setup,
  setSetup,
  submitBackground,
  seedDemo,
  goInbox,
  goSources,
  goRequests,
  goConnections
}: {
  facts: ApprovedFact[];
  candidates: MemoryCandidate[];
  connectors: ConnectorSession[];
  sources: VaultState["sources"];
  requests: ContextPackRequest[];
  contextPacks: ContextPack[];
  nativePath: string | null;
  setup: BackgroundSetupInput;
  setSetup: (input: BackgroundSetupInput) => void;
  submitBackground: () => void;
  seedDemo: () => void;
  goInbox: () => void;
  goSources: () => void;
  goRequests: () => void;
  goConnections: () => void;
}) {
  const backgroundFacts = facts.filter((fact) =>
    [
      "identity_and_profile",
      "values_goals_and_preferences",
      "life_events_and_plans",
      "routines_and_logistics",
      "home_and_places",
      "work_and_education",
      "relationships_and_household",
      "constraints_and_accessibility"
    ].includes(fact.domain)
  );
  const grouped = groupByDomain(backgroundFacts);
  const backgroundStarted = sources.length > 0 || candidates.length > 0 || facts.length > 0;
  const approvedContextReady = facts.length > 0;
  const aiAccessReady = Boolean(nativePath);
  const nowMs = Date.now();
  const deliverablePackCount = contextPacks.filter((pack) =>
    contextPackDeliveryState(
      pack,
      requests.find((request) => request.id === pack.requestId) ?? null,
      nowMs
    ).canDeliver
  ).length;
  const packTried = deliverablePackCount > 0;
  const accessReadiness = { tone: "ready" as const, title: "MCPで接続", body: "Claude Desktop等のMCPクライアントから接続できます。", badge: "ok" };
  const pendingRequestCount = requests.filter((request) => requestNeedsUserAction(request, nowMs)).length;
  const aiBoundarySections = homeAiBoundarySections({
    facts,
    candidates,
    requests,
    contextPacks
  });
  const nextActionKind = homeNextActionKind({
    candidateCount: candidates.length,
    backgroundStarted,
    approvedFactCount: facts.length,
    pendingRequestCount,
    deliverablePackCount,
    aiAccessReady
  });
  const focusSetup = () => {
    document.getElementById("home-guided-setup")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const onboardingSteps: OnboardingStep[] = [
    {
      title: "生活背景を入れる",
      body: backgroundStarted
        ? "Sourceまたは候補が作成されています。"
        : "呼び名、制約、いま動いている生活領域から始めます。",
      status: backgroundStarted ? "done" : "current",
      actionLabel: backgroundStarted ? "Sourceを見る" : "入力欄へ",
      action: backgroundStarted ? goSources : focusSetup
    },
    {
      title: "候補を承認する",
      body: approvedContextReady
        ? `${facts.length}件のApprovedFactがAIに使える状態です。`
        : candidates.length > 0
          ? `${candidates.length}件の候補が承認待ちです。`
          : "候補ができたら、保存するものだけFactにします。",
      status: approvedContextReady ? "done" : candidates.length > 0 ? "current" : "blocked",
      actionLabel: "Inboxを開く",
      action: goInbox
    },
    {
      title: "Context Packを試す",
      body: packTried
        ? `${deliverablePackCount}件の取得可能Context Packがあります。`
        : approvedContextReady
          ? "MCPなしでも、確認してコピーすれば普段使うAIで試せます。"
          : "ApprovedFactができたら、AIへ渡す最小文脈を確認します。",
      status: packTried ? "done" : approvedContextReady ? "current" : "blocked",
      actionLabel: "Requestsを開く",
      action: goRequests
    },
    {
      title: "AI連携を常用化する",
      body: aiAccessReady
        ? "外部AIからContext Packを呼べる状態です。"
        : packTried
          ? accessReadiness.body
          : "最初のPack確認後に、Claude DesktopやHosted Relayへ接続できます。",
      status: aiAccessReady ? "done" : packTried ? "current" : "blocked",
      actionLabel: aiAccessReady ? "Connectionsを見る" : nativePath ? "AI Accessを起動" : "Connectionsを見る",
      action: aiAccessReady || !nativePath ? goConnections : goConnections,
      disabled: false
    }
  ];
  const nextAction = (() => {
    if (nextActionKind === "review_candidates") {
      return {
        title: `${candidates.length}件の候補を確認`,
        body: "保存する生活文脈だけをFactにします。承認前の候補はAIには渡りません。",
        label: "Inboxで確認",
        action: goInbox,
        icon: <Inbox size={18} />
      };
    }
    if (nextActionKind === "add_background") {
      return {
        title: "生活背景を追加",
        body: "呼び名、制約、いま動いている生活領域からMemory Inbox候補を作ります。",
        label: "入力欄へ",
        action: focusSetup,
        icon: <Sparkles size={18} />
      };
    }
    if (nextActionKind === "review_pending_request") {
      return {
        title: `${pendingRequestCount}件のContext Packを確認`,
        body: "外部AIに渡る最小文脈を見て、不要なFactを外してから承認できます。",
        label: "Requestsで確認",
        action: goRequests,
        icon: <MessageSquare size={18} />
      };
    }
    if (nextActionKind === "try_context_pack") {
      return {
        title: "Context Packを試す",
        body: "MCP接続前でも、確認した内容だけをコピーして普段使うAIに渡せます。",
        label: "Packを確認",
        action: goRequests,
        icon: <MessageSquare size={18} />
      };
    }
    if (nextActionKind === "connect_ai") {
      return {
        title: packTried ? "AI連携を常用化する" : nativePath ? "AI Accessを起動" : "DesktopでAI Accessを有効化",
        body: accessReadiness.body,
        label: nativePath ? "AI Accessを起動" : "Connectionsを見る",
        action: nativePath ? goConnections : goConnections,
        icon: <Plug size={18} />
      };
    }
    return {
      title: "Context Packを試す",
      body: "普段使うAIに渡る文脈を、Requestsで事前確認できます。",
      label: "Requestsを開く",
      action: goRequests,
      icon: <MessageSquare size={18} />
    };
  })();

  return (
    <section className="view-grid home-grid">
      <div className="panel wide launch-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">First 10 minutes</p>
            <h3>AIがあなたの生活文脈を使えるまで</h3>
          </div>
          <Badge>{accessReadiness.badge}</Badge>
        </div>
        <div className="home-start-grid">
          <div className="next-action-card">
            <div className="next-action-icon">{nextAction.icon}</div>
            <div>
              <p className="eyebrow">Next action</p>
              <h4>{nextAction.title}</h4>
              <p>{nextAction.body}</p>
            </div>
            <button
              className="primary-button"
              disabled={false && nextAction.action === goConnections}
              onClick={nextAction.action}
              type="button"
            >
              {nextAction.icon}
              {nextAction.label}
            </button>
          </div>
          <details className="onboarding-details">
            <summary>セットアップの手順を見る</summary>
          <div className="onboarding-checklist">
            {onboardingSteps.map((step, index) => (
              <button
                className={`onboarding-step ${step.status}`}
                disabled={step.disabled}
                key={step.title}
                onClick={step.action}
                type="button"
              >
                <span className="step-index">
                  {step.status === "done" ? <CheckCircle2 size={18} /> : <CircleDot size={18} />}
                  {index + 1}
                </span>
                <strong>{step.title}</strong>
                <small>{step.body}</small>
                <span className="step-action">
                  {step.actionLabel}
                  <ArrowRight size={14} />
                </span>
              </button>
            ))}
          </div>
          </details>
        </div>
      </div>

      <div className="panel wide home-ai-boundary-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI Boundary Today</p>
            <h3>保存されたこととAIへ渡ること</h3>
          </div>
          <ShieldCheck size={18} />
        </div>
        <div className="home-ai-boundary-grid" aria-label="Home AI boundary summary">
          {aiBoundarySections.map((section) => (
            <div className={`home-ai-boundary-card ${section.tone}`} key={section.label}>
              <span>{section.label}</span>
              <strong>{section.value}</strong>
              <small>{section.detail}</small>
            </div>
          ))}
        </div>
        <div className="service-actions">
          <button className="secondary-button" onClick={goInbox} type="button">
            <Inbox size={16} />
            保存候補を確認
          </button>
          <button className="primary-button" onClick={goRequests} type="button">
            <MessageSquare size={16} />
            AIへ渡すPackを見る
          </button>
        </div>
      </div>

      <div className="panel quick-setup-panel" id="home-guided-setup">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Guided setup</p>
            <h3>背景情報を追加</h3>
          </div>
        </div>
        <SetupForm setup={setup} setSetup={setSetup} submitBackground={submitBackground} compact />
      </div>


      <div className="panel background-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Background Snapshot</p>
            <h3>AIがいま理解している生活背景</h3>
          </div>
          <button className="secondary-button" onClick={goRequests} type="button">
            <MessageSquare size={16} />
            Requests
          </button>
        </div>
        {backgroundFacts.length === 0 ? (
          <div className="onboarding-card" role="region" aria-label="初回ガイド">
            <p className="eyebrow">Getting started</p>
            <h3>まずは3ステップで始めましょう</h3>
            <ol className="onboarding-steps">
              <li>
                <strong>1. 生活背景を少し書く</strong>
                <span>ガイド入力またはデモデータで、AIに覚えておいてほしい背景を追加します。保存前にMemory Inboxで確認します。</span>
                <button className="primary-button" onClick={seedDemo} type="button">
                  <Sparkles size={16} />
                  デモ投入
                </button>
              </li>
              <li>
                <strong>2. Memory Inbox で承認</strong>
                <span>生成された候補を確認します。承認したものだけがAIの確定文脈になります。</span>
                <button className="secondary-button" onClick={goInbox} type="button">
                  <Inbox size={16} />
                  Inboxを開く
                </button>
              </li>
              <li>
                <strong>3. 暗号化バックアップを作る</strong>
                <span>機種変・故障に備え、左の Settings から暗号化バックアップを書き出します（パスフレーズは紛失しないよう管理してください）。</span>
              </li>
            </ol>
          </div>
        ) : (
          <div className="domain-list">
            {Object.entries(grouped).map(([domain, items]) => (
              <section className="domain-section" key={domain}>
                <h4>{domainLabel(domain as LifeContextDomain)}</h4>
                {items.map((fact) => (
                  <FactRow fact={fact} key={fact.id} sources={sources} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Review queue</p>
            <h3>Memory Inbox</h3>
          </div>
          <button className="secondary-button" onClick={goInbox} type="button">
            <Inbox size={16} />
            Open
          </button>
        </div>
        <p className="large-number">{candidates.length}</p>
        <p className="muted">承認待ちの候補があります。承認されるまでAIの確定文脈には使われません。</p>
      </div>
    </section>
  );
}

function SetupForm({
  setup,
  setSetup,
  submitBackground,
  compact = false
}: {
  setup: BackgroundSetupInput;
  setSetup: (input: BackgroundSetupInput) => void;
  submitBackground: () => void;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "form-stack setup-form compact" : "form-stack setup-form"}>
      <Input label="呼び名" value={setup.displayName} onChange={(displayName) => setSetup({ ...setup, displayName })} placeholder="例: Kota" />
      <Input label="好みの口調" value={setup.tonePreference} onChange={(tonePreference) => setSetup({ ...setup, tonePreference })} placeholder="例: 落ち着いて具体的に" />
      <Textarea label="いま動いている生活領域" value={setup.activeLifeAreas} onChange={(activeLifeAreas) => setSetup({ ...setup, activeLifeAreas })} placeholder="仕事、家族、引っ越し、学習、健康管理など" />
      <Textarea label="繰り返し考慮してほしい制約" value={setup.recurringConstraints} onChange={(recurringConstraints) => setSetup({ ...setup, recurringConstraints })} placeholder="時間、予算、体力、移動、コミュニケーション上の制約" />
      <Textarea label="毎回確認してほしい話題" value={setup.confirmationTopics} onChange={(confirmationTopics) => setSetup({ ...setup, confirmationTopics })} placeholder="健康、給付、金融、家族など" />
      <button className="primary-button" onClick={submitBackground} type="button">
        <Sparkles size={16} />
        候補を作成
      </button>
    </div>
  );
}

export function InboxView({
  candidates,
  facts,
  edits,
  supersedes,
  setEdit,
  toggleSupersede,
  approve,
  reject,
  archive,
  markSensitive,
  goHome,
  goSources,
  goConnections
}: {
  candidates: MemoryCandidate[];
  facts: ApprovedFact[];
  edits: Record<string, string>;
  supersedes: Record<string, string[]>;
  setEdit: (id: string, value: string) => void;
  toggleSupersede: (candidateId: string, factId: string) => void;
  approve: (candidate: MemoryCandidate) => void;
  reject: (candidate: MemoryCandidate) => void;
  archive: (candidate: MemoryCandidate) => void;
  markSensitive: (candidate: MemoryCandidate) => void;
  goHome: () => void;
  goSources: () => void;
  goConnections: () => void;
}) {
  if (candidates.length === 0) {
    return (
      <EmptyState
        title="Inboxは空です"
        body="まずは生活背景、文書・メモ、AI会話Captureのどれかから候補を作れます。"
        action={
          <div className="inbox-empty-actions" aria-label="Memory Inbox start actions" role="group">
            <div className="inbox-empty-action-grid">
              <button className="primary-button" onClick={goHome} type="button">
                <Sparkles size={16} />
                背景情報を追加
              </button>
              <button className="secondary-button" onClick={goSources} type="button">
                <FileText size={16} />
                文書・メモを追加
              </button>
              <button className="secondary-button" onClick={goConnections} type="button">
                <Plug size={16} />
                AI会話Captureを設定
              </button>
            </div>
            <div className="trust-note compact-note inbox-empty-note">
              <ShieldCheck size={16} />
              <span>候補は承認するとFactになり、Context Pack確認後だけAIに渡ります。</span>
            </div>
          </div>
        }
      />
    );
  }

  return (
    <section className="candidate-list">
      {candidates.map((candidate) => {
        const conflictFactIds = candidate.conflictWithFactIds ?? [];
        const conflictOptions = facts.filter((fact) => conflictFactIds.includes(fact.id));
        const replacementOptions = [
          ...conflictOptions,
          ...facts.filter(
            (fact) =>
              fact.domain === candidate.domain &&
              fact.status === "active" &&
              !conflictFactIds.includes(fact.id)
          )
        ].slice(0, 4);
        const selectedSupersedes = supersedes[candidate.id] ?? [];
        return (
          <article className="candidate-card" key={candidate.id}>
            <div className="candidate-meta">
              <Badge>{domainLabel(candidate.domain)}</Badge>
              <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
              <Badge>{candidate.confidence}</Badge>
              {conflictFactIds.length > 0 && <Badge>衝突候補</Badge>}
            </div>
            <textarea
              aria-label="Candidate text"
              value={edits[candidate.id] ?? candidate.proposedFactText}
              onChange={(event) => setEdit(candidate.id, event.target.value)}
            />
            <p>{candidate.reasonToRemember}</p>
            {conflictFactIds.length > 0 && (
              <div className="warning-line conflict-line">
                <ShieldAlert size={16} />
                {candidate.conflictReason ?? "既存のFactと異なる可能性があります。保存前に置き換えるか確認してください。"}
              </div>
            )}
            {replacementOptions.length > 0 && (
              <div className="supersede-panel">
                <div className="trust-note compact-note">
                  <RefreshCw size={16} />
                  <span>この候補で古いFactを置き換える場合だけ選択します。置き換えたFactはContext Pack候補から外れ、履歴に残ります。</span>
                </div>
                <div className="supersede-options">
                  {replacementOptions.map((fact) => (
                    <label className="supersede-option" key={fact.id}>
                      <input
                        checked={selectedSupersedes.includes(fact.id)}
                        onChange={() => toggleSupersede(candidate.id, fact.id)}
                        type="checkbox"
                      />
                      <span>{fact.factText}</span>
                      {conflictFactIds.includes(fact.id) && <Badge>衝突</Badge>}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {candidate.status === "blocked_sensitive" && (
              <div className="warning-line">
                <ShieldAlert size={16} />
                センシティブ候補です。保存すると、この情報はContext Pack使用時にも確認対象になります。
              </div>
            )}
            <div className="action-row">
              <button className="primary-button" onClick={() => approve(candidate)} type="button">
                <Check size={16} />
                {selectedSupersedes.length > 0 ? "置き換えて保存" : "保存"}
              </button>
              <button className="secondary-button" onClick={() => markSensitive(candidate)} type="button">
                <ShieldAlert size={16} />
                Sensitive
              </button>
              <button className="secondary-button" onClick={() => archive(candidate)} type="button">
                <Archive size={16} />
                Later
              </button>
              <button className="danger-button" onClick={() => reject(candidate)} type="button">
                <X size={16} />
                却下
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function SourcesView({
  sources,
  candidates,
  facts,
  contextPacks,
  manualTitle,
  manualBody,
  setManualTitle,
  setManualBody,
  addManualSource,
  handleFileUpload,
  ocrExtractionAvailable,
  ocrProviderLabel,
  legacyOfficeConversionAvailable,
  legacyOfficeProviderLabel,
  sourceAccept,
  sourceLabel,
  uploadFeedback,
  changeSourceLifecycle,
  editSourceMetadata,
  editSourceBody,
  goInbox
}: {
  sources: VaultState["sources"];
  candidates: VaultState["candidates"];
  facts: VaultState["facts"];
  contextPacks: VaultState["contextPacks"];
  manualTitle: string;
  manualBody: string;
  setManualTitle: (value: string) => void;
  setManualBody: (value: string) => void;
  addManualSource: () => void;
  handleFileUpload: (file: File) => void;
  ocrExtractionAvailable: boolean;
  ocrProviderLabel: string | null;
  legacyOfficeConversionAvailable: boolean;
  legacyOfficeProviderLabel: string | null;
  sourceAccept: string;
  sourceLabel: string;
  uploadFeedback: UploadFeedback | null;
  changeSourceLifecycle: (sourceId: string, action: SourceLifecycleAction) => void;
  editSourceMetadata: (sourceId: string, input: SourceMetadataUpdate) => Promise<boolean>;
  editSourceBody: (sourceId: string, input: SourceBodyUpdate) => Promise<boolean>;
  goInbox: () => void;
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  const pendingSourceCandidates = sourceReviewCandidates(candidates);
  const documentReadiness = documentIngestionReadiness(
    ocrExtractionAvailable,
    ocrProviderLabel,
    legacyOfficeConversionAvailable,
    legacyOfficeProviderLabel
  );
  function handleDropZoneDrag(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setIsDragActive(true);
  }

  function handleDropZoneLeave(event: React.DragEvent<HTMLLabelElement>) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) return;
    setIsDragActive(false);
  }

  function handleDropZoneDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragActive(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void handleFileUpload(file);
  }

  return (
    <section className="view-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Manual source</p>
            <h3>会話・メモから追加</h3>
          </div>
        </div>
        <div className="form-stack">
          <div className="trust-note">
            <ShieldCheck size={16} />
            <span>ここで保存されるのはSourceと未承認候補です。AIへ渡るのはInboxで承認したFactから作るContext Packだけです。</span>
          </div>
          <Input label="タイトル" value={manualTitle} onChange={setManualTitle} placeholder="例: 引っ越しの相談メモ" />
          <Textarea label="本文" value={manualBody} onChange={setManualBody} placeholder="生活背景として覚えておくと役立つ内容" />
          <button className="primary-button" onClick={addManualSource} type="button">
            <Sparkles size={16} />
            候補を生成
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Upload</p>
            <h3>文書を追加</h3>
          </div>
        </div>
        <label
          aria-label={`文書を追加: ${sourceLabel}`}
          className={isDragActive ? "drop-zone drag-active" : "drop-zone"}
          onDragEnter={handleDropZoneDrag}
          onDragLeave={handleDropZoneLeave}
          onDragOver={handleDropZoneDrag}
          onDrop={handleDropZoneDrop}
        >
          <Upload size={24} />
          <strong>{isDragActive ? "ここにドロップ" : "ファイルを選択 / ドロップ"}</strong>
          <span>{sourceLabel}</span>
          <small>1ファイルずつ追加します</small>
          <input
            aria-label="文書ファイルを選択"
            accept={sourceAccept}
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFileUpload(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {uploadFeedback && (
          <div className={`upload-feedback ${uploadFeedback.tone}`}>
            {uploadFeedback.tone === "ready" ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
            <div>
              <strong>{uploadFeedback.title}</strong>
              <span>{uploadFeedback.body}</span>
            </div>
          </div>
        )}
        <div className="trust-note">
          <ShieldCheck size={16} />
          <span>
            PDF/OfficeはDesktopでローカル抽出します。
            {ocrExtractionAvailable
              ? ` 画像は ${ocrProviderLabel ?? "OCR Provider"} をローカル実行して抽出し、Inbox候補として確認します。`
              : " 画像OCRは、誤記憶を避けるためProvider接続までSource化しません。"}
            {legacyOfficeConversionAvailable
              ? ` 旧Office形式は ${legacyOfficeProviderLabel ?? "Legacy Office Provider"} でローカル変換してから抽出します。`
              : " 旧Office形式は、誤記憶を避けるため変換Provider接続までSource化しません。"}
          </span>
        </div>
        <div className="document-readiness-grid" aria-label="Document ingestion readiness">
          {documentReadiness.map((item) => (
            <div className={`document-readiness-card ${item.state}`} key={item.label}>
              {item.state === "ready" ? <CheckCircle2 size={16} /> : <ShieldAlert size={16} />}
              <div>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            </div>
          ))}
        </div>
      </div>

      {pendingSourceCandidates.length > 0 && (
        <div className="panel wide source-review-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Review queue</p>
              <h3>Sourceから作られた承認待ち候補</h3>
            </div>
            <Badge>{pendingSourceCandidates.length}件</Badge>
          </div>
          <div className="trust-note">
            <ShieldCheck size={16} />
            <span>ここにある候補はまだFactではありません。Inboxで保存するまでContext Pack候補にもAI送信対象にもなりません。</span>
          </div>
          <div className="source-review-list">
            {pendingSourceCandidates.slice(0, 3).map((candidate) => (
              <div className="source-review-row" key={candidate.id}>
                <div>
                  <strong>{candidate.proposedFactText}</strong>
                  <span>{domainLabel(candidate.domain)} / {candidate.reasonToRemember}</span>
                </div>
                <div className="source-review-meta">
                  <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
                  <Badge>{candidate.confidence}</Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="action-row">
            <button className="primary-button" onClick={goInbox} type="button">
              <Inbox size={16} />
              Inboxで承認
            </button>
            {pendingSourceCandidates.length > 3 && <span className="muted">ほか {pendingSourceCandidates.length - 3}件</span>}
          </div>
        </div>
      )}

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Source history</p>
            <h3>追加済みSource</h3>
          </div>
        </div>
        <div className="trust-note">
          <Archive size={16} />
          <span>Sourceを停止または本文消去すると、未承認候補はLaterへ移り、関連Factは再確認待ちになります。再確認待ちFactはContext Packから外れます。</span>
        </div>
        <div className="table-list">
          {sources.map((source) => {
            const linkedCandidateCount = candidates.filter((candidate) => candidate.sourceIds.includes(source.id)).length;
            const linkedFacts = facts.filter((fact) => fact.sourceIds.includes(source.id));
            const linkedFactCountValue = linkedFacts.length;
            const linkedPackCount = contextPacks.filter((pack) =>
              pack.items.some((item) => linkedFacts.some((fact) => fact.id === item.factId))
            ).length;
            return (
              <SourceRow
                changeSourceLifecycle={changeSourceLifecycle}
                editSourceMetadata={editSourceMetadata}
                editSourceBody={editSourceBody}
                key={source.id}
                linkedCandidateCount={linkedCandidateCount}
                linkedFactCount={linkedFactCountValue}
                linkedPackCount={linkedPackCount}
                source={source}
              />
            );
          })}
          {sources.length === 0 && <p className="muted">まだSourceがありません。</p>}
        </div>
      </div>
    </section>
  );
}

function SourceRow({
  source,
  linkedCandidateCount,
  linkedFactCount,
  linkedPackCount,
  changeSourceLifecycle,
  editSourceMetadata,
  editSourceBody
}: {
  source: VaultState["sources"][number];
  linkedCandidateCount: number;
  linkedFactCount: number;
  linkedPackCount: number;
  changeSourceLifecycle: (sourceId: string, action: SourceLifecycleAction) => void;
  editSourceMetadata: (sourceId: string, input: SourceMetadataUpdate) => Promise<boolean>;
  editSourceBody: (sourceId: string, input: SourceBodyUpdate) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<SourceMetadataUpdate | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [confirmBodyPurge, setConfirmBodyPurge] = useState(false);
  const retentionLabel = sourceRetentionLabel(source);
  const canPromote = Boolean(source.retentionUntil);

  useEffect(() => {
    if (source.deletionState === "purged") setConfirmBodyPurge(false);
  }, [source.deletionState]);

  return (
    <div className="table-row source-row">
      <div className="source-main">
        {bodyDraft !== null ? (
          <div className="source-edit-form source-body-edit-form">
            <Textarea
              label="Source本文"
              value={bodyDraft}
              onChange={setBodyDraft}
              placeholder="再抽出したい本文"
            />
            <div className="trust-note">
              <RefreshCw size={16} />
              <span>保存すると未承認候補を再生成します。既存のApprovedFactは再確認待ちになり、関連Context Packは無効化されます。</span>
            </div>
          </div>
        ) : draft ? (
          <div className="source-edit-form">
            <Input
              label="Sourceタイトル"
              value={draft.title}
              onChange={(value) => setDraft({ ...draft, title: value })}
              placeholder="根拠として見分けやすい名前"
            />
            <div className="source-edit-grid">
              <label className="field">
                <span>Source感度</span>
                <select
                  value={draft.defaultSensitivity}
                  onChange={(event) =>
                    setDraft({ ...draft, defaultSensitivity: event.target.value as SensitivityTier })
                  }
                >
                  {sensitivityOptions.filter((sensitivity) => sensitivity !== "all").map((sensitivity) => (
                    <option key={sensitivity} value={sensitivity}>
                      {sensitivityLabel(sensitivity as SensitivityTier)}
                    </option>
                  ))}
                </select>
              </label>
              {canPromote && (
                <label className="toggle-row compact-toggle">
                  <input
                    checked={Boolean(draft.promotedToLongTerm)}
                    onChange={(event) =>
                      setDraft({ ...draft, promotedToLongTerm: event.target.checked })
                    }
                    type="checkbox"
                  />
                  <div>
                    <strong>長期保持</strong>
                    <span>{source.retentionUntil ? new Date(source.retentionUntil).toLocaleDateString() : ""}</span>
                  </div>
                </label>
              )}
            </div>
          </div>
        ) : (
          <>
            <strong>{source.title}</strong>
            <span>{source.kind} / {new Date(source.createdAt).toLocaleString()}</span>
            <div className="source-meta">
              <Badge>{sourceLifecycleLabel(source.deletionState)}</Badge>
              <Badge>{source.body ? "本文あり" : "本文なし"}</Badge>
              {retentionLabel && <Badge>{retentionLabel}</Badge>}
              <Badge>候補 {linkedCandidateCount}</Badge>
              <Badge>Fact {linkedFactCount}</Badge>
              <Badge>Pack {linkedPackCount}</Badge>
            </div>
            {confirmBodyPurge && (
              <div className="danger-confirm-card inline-confirm" role="status">
                <strong>このSource本文を消去します</strong>
                <span>
                  本文は戻せません。未承認候補 {linkedCandidateCount}件、関連Fact {linkedFactCount}件、関連Context Pack {linkedPackCount}件に影響します。
                </span>
                <button className="secondary-button" onClick={() => setConfirmBodyPurge(false)} type="button">
                  <X size={16} />
                  取消
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <div className="source-actions">
        <SensitivityBadge sensitivity={source.defaultSensitivity} />
        {bodyDraft !== null ? (
          <>
            <button
              className="primary-button"
              onClick={async () => {
                const saved = await editSourceBody(source.id, { body: bodyDraft });
                if (saved) setBodyDraft(null);
              }}
              type="button"
            >
              <RefreshCw size={16} />
              保存して再抽出
            </button>
            <button className="secondary-button" onClick={() => setBodyDraft(null)} type="button">
              <X size={16} />
              取消
            </button>
          </>
        ) : draft ? (
          <>
            <button
              className="primary-button"
              onClick={async () => {
                const saved = await editSourceMetadata(source.id, draft);
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
          <>
            <button
              className="secondary-button"
              onClick={() =>
                setDraft({
                  title: source.title,
                  defaultSensitivity: source.defaultSensitivity,
                  promotedToLongTerm: source.promotedToLongTerm ?? false
                })
              }
              type="button"
            >
              <Settings size={16} />
              編集
            </button>
            {source.deletionState === "active" && source.body && (
              <button
                className="secondary-button"
                onClick={() => setBodyDraft(source.body)}
                type="button"
              >
                <RefreshCw size={16} />
                本文編集
              </button>
            )}
          </>
        )}
        {source.deletionState === "active" && (
          <button
            className="secondary-button"
            onClick={() => changeSourceLifecycle(source.id, "soft_delete")}
            type="button"
          >
            <Archive size={16} />
            使用停止
          </button>
        )}
        {source.deletionState === "soft_deleted" && (
          <button
            className="secondary-button"
            onClick={() => changeSourceLifecycle(source.id, "restore")}
            type="button"
          >
            <RefreshCw size={16} />
            復元
          </button>
        )}
        {source.deletionState !== "purged" && (
          <button
            className="danger-button"
            onClick={() => {
              if (!confirmBodyPurge) {
                setConfirmBodyPurge(true);
                return;
              }
              setConfirmBodyPurge(false);
              changeSourceLifecycle(source.id, "purge_body");
            }}
            type="button"
          >
            <X size={16} />
            {confirmBodyPurge ? "確認して本文消去" : "本文消去"}
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectView({
  nativePath,
  claudeInstallBusy,
  claudeInstallResult,
  claudeConfig,
  installClaudeConfig,
  loginItemStatus,
  loginItemBusy,
  enableLoginItem,
  disableLoginItem,
  goRequests
}: {
  nativePath: string | null;
  claudeInstallBusy: boolean;
  claudeInstallResult: ClaudeDesktopConfigInstallResult | null;
  claudeConfig: string;
  installClaudeConfig: () => void;
  loginItemStatus: LoginItemStatus | null;
  loginItemBusy: boolean;
  enableLoginItem: () => void;
  disableLoginItem: () => void;
  goRequests: () => void;
}) {
  return (
    <section className="view-grid">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Claude Desktop (MCP)</p>
            <h3>ローカルMCPで接続</h3>
          </div>
          <Plug size={18} />
        </div>
        <p className="muted">
          Claude Desktop設定に Life Context Vault のMCPサーバーを追加します。追加後、Claude Desktopから承認済みの文脈(Context Pack)を要求できます。
        </p>
        <div className="service-actions">
          <button
            className="primary-button"
            disabled={claudeInstallBusy || !nativePath}
            onClick={installClaudeConfig}
            type="button"
          >
            <Plug size={16} />
            Claude設定へ追加
          </button>
          {loginItemStatus && loginItemStatus.supported ? (
            <button
              className="secondary-button"
              disabled={loginItemBusy}
              onClick={loginItemStatus.enabled ? disableLoginItem : enableLoginItem}
              type="button"
            >
              {loginItemStatus.enabled ? "ログイン時起動を解除" : "ログイン時に起動"}
            </button>
          ) : null}
        </div>
        {claudeInstallResult ? <p className="muted">設定パス: {claudeInstallResult.configPath}</p> : null}
        <details className="advanced-panel">
          <summary>MCP設定（手動コピー用）</summary>
          <pre className="code-box">{claudeConfig}</pre>
        </details>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Copy fallback</p>
            <h3>コピーでAIに渡す</h3>
          </div>
          <MessageSquare size={18} />
        </div>
        <p className="muted">
          MCPを使わず、Requests で Context Pack を作成してコピーし、任意のAI（ChatGPT / Claude 等）に貼り付けられます。設定不要です。
        </p>
        <div className="service-actions">
          <button className="secondary-button" onClick={goRequests} type="button">
            <MessageSquare size={16} />
            Requestsへ
          </button>
        </div>
      </div>
    </section>
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
      ? "外部AIへ返す前に、使うFact・根拠・除外理由を確認できます。"
      : unreturnedLowRiskRequests.length > 0
        ? "低リスクでも、AIへ返す前に送信内容をここで確認できます。"
        : showCopyFallbackStarter
          ? "新しいAI要求が届くとここに並びます。MCPなしで使う場合は下でContext Packを作成します。"
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
      <p className="muted">MCPなしでも、AIへ渡す前に同じContext Pack確認とAuditを通します。</p>
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
              body="ChatGPT/Claudeなどから要求が届くと、AIへ返す前にこのInboxで確認できます。MCPなしで使う場合は下でContext Packを作成します。"
            />
          )}
        </div>
        {showCopyFallbackStarter ? (
          <div className="copy-fallback-starter">
            <div className="panel-heading compact-heading">
              <div>
                <p className="eyebrow">コピーFallback</p>
                <h3>MCPなしでContext Packを作る</h3>
              </div>
              <Clipboard size={18} />
            </div>
            <div className="trust-note">
              <ShieldCheck size={16} />
              <span>ここで作ったPackも、確認画面で許可またはコピーするまでAIには渡りません。</span>
            </div>
            {requestComposer("確認用Context Packを作成")}
          </div>
        ) : (
          <details className="advanced-panel request-test-panel">
            <summary>手動でContext Packを試す</summary>
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
                {aiReady ? "本文をコピー" : "確認してコピーFallback"}
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
                {currentPack.items.length}件のFactと{currentPack.sourceSnippets?.length ?? 0}件の根拠snippetだけを送信予定。除外は{currentPack.excludedItems.length}件です。
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
              {currentPack.items.length === 0 && <p className="muted">使える承認済みFactがまだありません。</p>}
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
                  <p>Raw Source本文や高感度SourceタイトルはAIへ渡しません。上のFact本文と理由だけがPack本文に含まれます。</p>
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
                <strong>あなたがこのAIから外したFact</strong>
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
            <h3>AIが使える保存済みFact</h3>
          </div>
          <Badge>{inventory.active} Context Pack候補</Badge>
        </div>
        <div className="context-inventory-grid">
          <Metric label="Context Pack候補" value={inventory.active} />
          <Metric label="再確認待ち" value={inventory.needsReview} />
          <Metric label="非表示/削除" value={inventory.hiddenOrDeleted} />
          <Metric label="履歴/期限切れ" value={inventory.history} />
        </div>
        <div className={inventory.needsReview > 0 ? "trust-note attention-note" : "trust-note"}>
          <ShieldCheck size={16} />
          <span>
            Context Pack候補に入るのはActiveなApprovedFactだけです。再確認待ち、非表示、削除済み、期限切れ、置き換え済みFactはAIに渡しません。
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
              <h3>AIに使う前に確認が必要なFact</h3>
            </div>
            <Badge>{reviewFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <ShieldAlert size={16} />
            <span>Sourceが停止・本文消去・本文更新されたFactです。保持するとContext Pack候補へ戻り、非表示/削除すると既存Packも無効化されます。</span>
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
        {results.length === 0 && <p className="muted">一致するApprovedFactがありません。</p>}
      </div>
      {filteredExcludedFacts.length > 0 && (
        <div className="memory-review-panel excluded-facts-panel">
          <div className="panel-heading compact-heading">
            <div>
              <p className="eyebrow">Outside AI context</p>
              <h3>Context Pack候補から外れているFact</h3>
            </div>
            <Badge>{filteredExcludedFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <EyeOff size={16} />
            <span>非表示、削除済みのFactです。AIに使う必要が戻ったものだけ、明示的にContext Pack候補へ戻します。</span>
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
              <h3>置き換え済みFact</h3>
            </div>
            <Badge>{supersededFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <RefreshCw size={16} />
            <span>ここにあるFactは履歴として残っていますが、通常の検索結果やContext Pack候補には入りません。</span>
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
                <Metric label="保存済みFact" value={restorePreview.counts.facts} />
                <Metric label="Inbox候補" value={restorePreview.counts.candidates} />
                <Metric label="Context Packs" value={restorePreview.counts.packs} />
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
            <span>旧Office変換は指定したローカルコマンドだけを実行します。変換後の本文はSourceと未承認候補になり、承認前にAIへ渡りません。</span>
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
                    この候補を使う
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
            <span>画像OCRは指定したローカルコマンドだけを実行します。抽出結果はSourceと未承認候補になり、承認前にAIへ渡りません。</span>
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
                    この候補を使う
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
              <span>Vaultをクリアすると、Sources、候補、Fact、Context Pack、接続監査が空になります。バックアップが必要なら先にバックアップを作成してください。</span>
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

function AuditView({ events }: { events: VaultState["auditEvents"] }) {
  const aiBoundaryEvents = events
    .filter(isAiBoundaryAuditEvent)
    .slice(0, 12);
  const deliveredCount = events.filter((event) => event.eventType === "context_pack_delivered").length;
  const confirmedCount = events.filter((event) => event.eventType === "context_pack_confirmed").length;
  const blockedCount = events.filter(
    (event) =>
      event.eventType === "context_pack_denied" ||
      (event.eventType === "context_pack_updated" && metadataString(event, "action") === "policy_invalidated")
  ).length;

  return (
    <section className="view-grid audit-grid">
      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI delivery receipts</p>
            <h3>どのAIに何が渡ったか</h3>
          </div>
          <ShieldCheck size={18} />
        </div>
        <div className="audit-summary-grid">
          <Metric label="AIに渡した回数" value={String(deliveredCount)} />
          <Metric label="取得可能にしたPack" value={String(confirmedCount)} />
          <Metric label="拒否・失効" value={String(blockedCount)} />
        </div>
        <div className="delivery-receipt-list">
          {aiBoundaryEvents.map((event) => (
            <article className={`delivery-receipt ${auditReceiptTone(event)}`} key={event.id}>
              <div>
                <strong>{auditReceiptTitle(event)}</strong>
                <span>{auditReceiptBody(event)}</span>
                <small>{formatDateTime(event.occurredAt)} / {event.subjectId}</small>
              </div>
              <div className="delivery-receipt-meta">
                <SensitivityBadge sensitivity={event.sensitivity} />
                {metadataString(event, "trustBoundary") && <Badge>{metadataString(event, "trustBoundary")}</Badge>}
                {typeof metadataNumber(event, "itemCount") === "number" && (
                  <Badge>{metadataNumber(event, "itemCount")} Facts</Badge>
                )}
                {metadataString(event, "deliveryChannel") && <Badge>{deliveryChannelLabel(metadataString(event, "deliveryChannel"))}</Badge>}
              </div>
            </article>
          ))}
          {aiBoundaryEvents.length === 0 && (
            <p className="muted">まだAIへの配達レシートはありません。Context Packを承認またはコピーするとここに残ります。</p>
          )}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Audit trail</p>
            <h3>保存されたこと、AIに渡ったこと、拒否したこと</h3>
          </div>
          <Clock size={18} />
        </div>
        <div className="table-list">
          {events.slice(0, 80).map((event) => (
            <div className="audit-row" key={event.id}>
              <div>
                <strong>{auditEventLabel(event)}</strong>
                <span>
                  {event.subjectType} / {formatDateTime(event.occurredAt)}
                </span>
                <span>{auditCompactMetadata(event)}</span>
              </div>
              <div className="audit-meta">
                <SensitivityBadge sensitivity={event.sensitivity} />
                <Badge>{event.actor}</Badge>
              </div>
            </div>
          ))}
          {events.length === 0 && <p className="muted">まだ監査イベントはありません。</p>}
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
  return `${client}へのContext Packを送信不可にしました`;
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
    typeof itemCount === "number" ? `${itemCount}件のApprovedFact` : null,
    typeof snippetCount === "number" ? `${snippetCount}件の根拠スニペット` : null,
    typeof excludedCount === "number" ? `${excludedCount}件を除外` : null,
    ttl ? `有効期限は約${Math.max(1, Math.round(ttl / 60))}分` : null
  ].filter(Boolean);
  const summary = pieces.length > 0 ? pieces.join("、") : "Context Pack本文はAuditに保存していません";
  return `${summary}。Raw Source本文と未承認候補は含めていません。`;
}

function deliveryChannelLabel(channel: string): string {
  if (channel === "clipboard_copy") return "コピー";
  if (channel === "relay_handoff") return "Relay";
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
    fact_created: "Fact作成",
    fact_updated: "Fact更新",
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
    typeof itemCount === "number" ? `Fact: ${itemCount}` : null,
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
              label="Fact本文"
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
            <span>{domainLabel(fact.domain)} / {fact.confidence} / {factStatusLabel(fact.status)}</span>
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
            Context Pack候補へ戻す
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

export function homeNextActionKind({
  candidateCount,
  backgroundStarted,
  approvedFactCount,
  pendingRequestCount,
  deliverablePackCount,
  aiAccessReady
}: {
  candidateCount: number;
  backgroundStarted: boolean;
  approvedFactCount: number;
  pendingRequestCount: number;
  deliverablePackCount: number;
  aiAccessReady: boolean;
}): HomeNextActionKind {
  if (candidateCount > 0) return "review_candidates";
  if (!backgroundStarted) return "add_background";
  if (pendingRequestCount > 0) return "review_pending_request";
  if (approvedFactCount === 0) return "add_background";
  if (approvedFactCount > 0 && deliverablePackCount === 0) return "try_context_pack";
  if (!aiAccessReady) return "connect_ai";
  return "try_context_pack";
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
      value: `${activeFactCount} Facts`,
      detail:
        activeFactCount > 0
          ? "ApprovedFactだけがContext Pack候補になります。"
          : "Sourceや候補だけではAIに渡る文脈になりません。",
      tone: activeFactCount > 0 ? "ready" : "attention"
    },
    {
      label: "未承認で止める",
      value: `${reviewCandidateCount} candidates`,
      detail:
        reviewCandidateCount > 0
          ? "Inboxで保存するまで、候補はAIの確定文脈に使いません。"
          : "未承認候補はありません。",
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
      : "Raw Source本文、未承認候補、削除済み/期限切れFactは送信対象にしていません。";

  return [
    {
      label: "AIに渡る",
      tone: pack.items.length > 0 || snippetCount > 0 ? "ready" : "attention",
      value: `${pack.items.length} Facts / ${snippetCount} snippets`,
      detail: `${clientName}へ渡るのは承認済みFactと最小snippetだけです。最高感度は${sensitivityLabel(pack.maxSensitivityIncluded)}です。`
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

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>;
}

function SensitivityBadge({ sensitivity }: { sensitivity: SensitivityTier }) {
  return <span className={`badge sensitivity ${sensitivity}`}>{sensitivityLabel(sensitivity)}</span>;
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
    return "この短命Context Packは期限切れです。再度Context Packを作成すると、現在のPolicyで確認できます。";
  }
  if (state?.canDeliver) {
    return "外部AIはget_request_statusで、このContext Packだけを取得できます。";
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
    secret_never_send: "送信禁止"
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
    return `Sourceを復元しました。${affectedFactCount}件のFactを再びContext Pack候補に戻しました。`;
  }
  if (action === "purge_body") {
    return `Source本文を消去しました。${affectedFactCount}件のFactを再確認待ちにし、${invalidatedPackCount}件のContext Packを無効化しました。`;
  }
  return `Sourceを使用停止しました。${affectedFactCount}件のFactを再確認待ちにし、${invalidatedPackCount}件のContext Packを無効化しました。`;
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
    sensitivitySummary: highestSensitivity ? sensitivityLabel(highestSensitivity) : "空のVault",
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
          : "保存されたSource本文は復元されます。AIへ渡るのは承認済みContext Packだけです。",
      tone: input.counts.sources > 0 ? "attention" : "ready"
    },
    {
      label: "Approved Facts",
      value: `${input.counts.facts}件`,
      detail: "ユーザ承認済みFactとして戻ります。未承認候補はInboxに残り、Factとしては使われません。",
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
          : "Passive Captureイベントを含みます。承認前の候補はAI回答に使いません。",
      tone: input.expiredCaptureCount > 0 ? "attention" : "ready"
    },
    {
      label: "Auditレシート",
      value: `${input.counts.auditEvents}件`,
      detail:
        input.highestSensitivity === "secret_never_send"
          ? "最高感度に送信禁止データを含みます。Context Pack境界とPolicyを確認してください。"
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
          : "復元後すぐ外部AIへ返せるPackはありません。必要なら新しいContext Packを作成します。",
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
          : "保存済みSource本文はありません。FactとInbox候補も空になります。",
      tone: hasSavedContext ? "attention" : "ready"
    },
    {
      label: "AI境界",
      value: `${counts.requests} Requests / ${counts.packs} Packs`,
      detail:
        hasAiBoundaryRecords
          ? `${aiBoundary.deliverablePackCount}件の取得可能Pack、${aiBoundary.pendingRequestCount}件の確認/返却待ち、${aiBoundary.expiredPackCount}件の期限切れPackのローカル履歴を削除します。`
          : "Context RequestとContext Packはありません。",
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
      detail: "現在のSource、Fact、Inbox候補はバックアップ側の内容へ置き換わります。",
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
      title: "許可サイトだけをローカルで候補化中",
      body:
        "Captureは未承認候補を作るだけです。Fact化とAI送信は、Memory InboxとContext Pack確認を通ります。",
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
  if (source.deletionState === "purged") return "本文は消去済みです。候補やFactは確認待ちになります。";
  const text = source.body.replace(/\s+/g, " ").trim();
  if (!text) return "本文は空です。";
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

function captureEventStatusLabel(
  event: PassiveCaptureEvent,
  source?: VaultState["sources"][number]
): string {
  if (source?.deletionState === "purged" || event.processingStatus === "purged") return "本文消去済み";
  if (event.processingStatus === "candidate_generated") return "候補作成";
  if (event.processingStatus === "captured") return "取得済み";
  return "候補なし";
}

function sourceMetadataNotice(invalidatedPackCount: number): string {
  return `Sourceを更新しました。${invalidatedPackCount}件のContext Packを無効化しました。`;
}

function sourceBodyNotice(
  candidateCount: number,
  affectedFactCount: number,
  invalidatedPackCount: number
): string {
  return `Source本文を保存し、${candidateCount}件の候補を再生成しました。${affectedFactCount}件のFactを再確認待ちにし、${invalidatedPackCount}件のContext Packを無効化しました。`;
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
      body: `${file.name} は画像として検出しました。SettingsのLocal OCRで検出候補を使うか、ローカルOCRコマンドを設定するまでは、テキスト化した内容をManual sourceに貼り付けてください。`
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
      detail: "本文はSourceとInbox候補になり、Fact化とAI送信は別確認です。"
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
      description: "HomebrewでTesseract本体と言語データを入れます。インストール後は検出候補を使うのが安全です。",
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
    return "Factを保持し、Context Pack候補へ戻しました。";
  }
  if (action === "hide") {
    return `FactをContext Pack候補から非表示にしました。${invalidatedPackCount}件のContext Packを無効化しました。`;
  }
  if (action === "delete") {
    return `Factを削除済みにしました。${invalidatedPackCount}件のContext Packを無効化しました。`;
  }
  return `Factを再確認待ちにしました。${invalidatedPackCount}件のContext Packを無効化しました。`;
}

function factMetadataNotice(invalidatedPackCount: number): string {
  return `Factを更新しました。${invalidatedPackCount}件のContext Packを無効化しました。`;
}

function candidateApprovalNotice(supersededFactCount: number, invalidatedPackCount: number): string {
  if (supersededFactCount > 0) {
    return `新しいFactとして保存し、${supersededFactCount}件の古いFactを置き換えました。${invalidatedPackCount}件のContext Packを無効化しました。`;
  }
  return "承認済みFactとして保存しました。AIへ渡るのはContext Pack確認後だけです。";
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
      body: "暗号化SQLiteのApprovedFactだけを検索します。未承認候補とRaw Source本文は結果に含めません。",
      tone: "ready"
    };
  }
  if (mode === "loading") {
    return {
      title: "Vault Core FTSを更新中",
      body: "最新のApprovedFact索引を読み込んでいます。",
      tone: "attention"
    };
  }
  return {
    title: hasNativeVault ? "ブラウザ内検索へフォールバック中" : "ブラウザ内検索",
    body: hasNativeVault
      ? "ネイティブ検索に失敗したため、同期済みのローカル状態からApprovedFactだけを検索します。"
      : "Tauri外ではブラウザ内の同期済み状態からApprovedFactだけを検索します。",
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

function captureUrlForClient(client: ConnectorKind, conversationId: string): string {
  const id = encodeURIComponent(conversationId || "demo-thread");
  switch (client) {
    case "claude_desktop":
    case "claude_remote":
      return `https://claude.ai/chat/${id}`;
    case "gemini":
      return `https://gemini.google.com/app/${id}`;
    case "codex":
    case "generic_mcp":
      return `lcv-local://${client}/${id}`;
    case "copy_fallback":
      return `lcv-local://copy_fallback/${id}`;
    case "chatgpt":
    default:
      return `https://chatgpt.com/c/${id}`;
  }
}

function parseAllowedSitesInput(value: string): string[] {
  const sites: string[] = [];
  for (const item of value.split(/[,\n]/)) {
    const raw = item.trim().toLowerCase();
    if (!raw) continue;
    const withoutScheme = raw.includes("://") ? raw.split("://")[1] : raw;
    const host = withoutScheme
      .split("/")[0]
      .split(":")[0]
      .replace(/^\*\./, "")
      .replace(/\.+$/, "");
    if (!host || host.includes("@") || /\s/.test(host)) continue;
    if (!sites.includes(host)) sites.push(host);
  }
  return sites;
}

function EmptyState({
  title,
  body,
  action
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <Sparkles size={26} />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function titleForView(view: View): string {
  return {
    home: "Life Context Home",
    inbox: "Memory Inbox",
    sources: "Sources",
    connections: "AI Connections",
    requests: "Context Requests",
    search: "Search",
    audit: "Audit",
    settings: "Settings"
  }[view];
}

function connectionCopy(connector: ConnectorSession): string {
  if (connector.transport === "local_mcp") {
    return "同じ端末のAIクライアントから、Vault本体ではなくContext Packだけを要求します。";
  }
  if (connector.transport === "remote_mcp_relay") {
    return "Relayは短命Context Packの受け渡しだけを扱い、Vault本体は保持しません。";
  }
  if (connector.transport === "browser_extension") {
    return "AIチャット画面の会話断片をローカルに取り込み、未承認候補だけをInboxへ出します。";
  }
  return "MCPが使えないAI向けに、確認済みContext Packを手動で渡します。";
}

function serviceManagedCopy(status: any | null): string {
  if (!status) return "Desktopのみ";
  if (status.relayMode === "hosted_agent") return status.agentConnected ? "Hosted接続済み" : status.agentManagedRunning ? "Hosted確認中" : "Hosted停止中";
  if (status.relayManagedRunning && status.agentManagedRunning) return "ローカルRelay + Agent";
  if (status.relayManagedRunning) return "ローカルRelay";
  if (status.agentManagedRunning) return "ローカルAgent";
  if (status.relayReachable || status.agentConnected) return "外部Relay";
  return "停止中";
}

function hostedAgentProcessCopy(status: any | null): string {
  if (status?.relayMode !== "hosted_agent") return "未使用";
  return status.agentManagedRunning ? "起動中" : "停止中";
}

function hostedPairingCopy(status: any | null): string {
  if (status?.relayMode !== "hosted_agent") return "未接続";
  if (status.agentConnected) return "確認済み";
  const state = status.agentRuntimeStatus?.state;
  if (state === "connecting") return "確認中";
  if (state === "disconnected") return "再pairingが必要";
  return status.agentManagedRunning ? "待機中" : "停止中";
}

function hostedLastErrorCopy(status: any | null): string {
  if (status?.relayMode !== "hosted_agent") return "なし";
  return redactConnectionDiagnosticText(status.agentRuntimeStatus?.lastError) ?? "なし";
}

function aiAccessReadinessCopy(
  status: any | null,
  nativePath: string | null
): {
  badge: string;
  title: string;
  body: string;
  detail: string;
  tone: "ready" | "attention" | "neutral";
} {
  if (!nativePath) {
    return {
      badge: "Desktop required",
      title: "Desktop版でAI連携を管理できます",
      body: "ブラウザ表示だけでは、AIからVaultを呼ぶ常駐処理を起動できません。",
      detail:
        "Vault本体とAgentはローカルで動く前提です。Desktop版を開くと、RelayとAgentをここから起動できます。",
      tone: "neutral"
    };
  }
  if (status?.relayMode === "hosted_agent" && status.agentConnected) {
    return {
      badge: "Hosted ready",
      title: "Hosted Relayとのpairingを確認しました",
      body: "Web上のAIは公開HTTPS Relayへ要求し、Vault処理はこの端末のAgentが実行します。",
      detail:
        "外部AIへ渡る境界は確認済みContext Packだけです。Vault本文、Raw Source、未承認候補はHosted Relayへ保存しません。",
      tone: "ready"
    };
  }
  if (status?.relayMode === "hosted_agent" && status.agentManagedRunning) {
    const hostedError = redactConnectionDiagnosticText(status.agentRuntimeStatus?.lastError);
    return {
      badge: "Pairing check",
      title: "Hosted Relayへのpairingを待っています",
      body: "この端末のアプリは起動中です。Relay側の確認が取れるまでReady扱いにしません。",
      detail:
        hostedError
          ? `直近の接続エラー: ${hostedError}`
          : "Relayは短命Context Packの受け渡しだけを扱います。Vault本文、Raw Source、未承認候補はHosted Relayへ保存しません。",
      tone: "attention"
    };
  }
  if (status?.relayMode === "hosted_agent") {
    return {
      badge: "Hosted stopped",
      title: "Hosted Relayへ接続する端末アプリが停止しています",
      body: "短命Agent WebSocket URLを再発行して、この端末のAgentをもう一度起動してください。",
      detail:
        "pairing URLは保存しません。Hosted Relayで新しいURLを発行してから接続します。",
      tone: "attention"
    };
  }
  if (status?.agentConnected) {
    return {
      badge: "Ready",
      title: "AIがContext Packを要求できる状態です",
      body: "RelayとLocal Agentが接続済みです。Control Centerは閉じても常駐します。",
      detail:
        "外部AIへ渡る境界はContext Packだけです。未承認候補、Raw Source、Vault全体はこの接続から直接渡しません。",
      tone: "ready"
    };
  }
  if (status?.relayReachable && !status.relayManagedRunning) {
    return {
      badge: "External relay",
      title: "外部Relayを検知しています",
      body: "アプリは自分が起動していないRelayへAgentを自動接続しません。",
      detail:
        "手動で起動したRelayを使う場合は手動pairingを続けてください。アプリ管理にしたい場合は外部Relayを停止してからAI連携を開始します。",
      tone: "attention"
    };
  }
  if (status?.relayReachable) {
    return {
      badge: "Relay online",
      title: "Relayは起動していますがAgent待ちです",
      body: "Local Agentの接続が完了するとAIからVaultに要求を送れます。",
      detail:
        "AgentはVaultをローカルで検索し、ポリシーと確認画面を通したContext PackだけをRelayへ返します。",
      tone: "attention"
    };
  }
  return {
    badge: "Not started",
    title: "AI連携はまだ停止しています",
    body: "AI連携を開始するとRelayとLocal Agentをまとめて起動します。閉じた後はmenu bar/trayから戻せます。",
    detail:
      "最初は背景情報を承認してから起動すると、AIに渡すContext Packの確認まで一気に試せます。",
    tone: "neutral"
  };
}

export function redactConnectionDiagnosticText(value: string | null | undefined): string | null {
  if (!value) return null;
  const redacted = value
    .replace(/([?&](?:pairing_code|token|access_token|refresh_token|code)=)[^&\s]+/gi, "$1...")
    .replace(/\b(Authorization:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1...")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1...")
    .replace(/\b(Authorization:\s*)(?!Bearer\s)[^\s]+/gi, "$1...")
    .trim();
  return redacted.length > 180 ? `${redacted.slice(0, 177)}...` : redacted;
}

export function aiConnectionDiagnostic(
  status: any | null,
  nativePath: string | null,
  hostedAgentWebsocketUrl: string,
  webMcpEndpoint: string | null
): ConnectionDiagnostic {
  const hostedMode = status?.relayMode === "hosted_agent";
  const hostedUrlEntered = hostedAgentWebsocketUrl.trim().length > 0;
  const webReady = Boolean(webMcpEndpoint);
  const localReady = Boolean(status?.agentConnected && !hostedMode);
  const issue = redactConnectionDiagnosticText(status?.agentRuntimeStatus?.lastError ?? status?.lastError);
  const items: ConnectionDiagnosticItem[] = [
    {
      label: "Desktop Vault",
      value: nativePath ? "この端末で利用中" : "Desktop appが必要",
      state: nativePath ? "ready" : "blocked"
    },
    {
      label: "Relay",
      value: hostedMode
        ? status?.agentConnected
          ? "Hosted pairing済み"
          : status?.agentManagedRunning
          ? "Hosted確認待ち"
          : "Hosted停止中"
        : status?.relayReachable
        ? "endpoint応答あり"
        : "offline",
      state: hostedMode
        ? status?.agentConnected
          ? "ready"
          : "pending"
        : status?.relayReachable
        ? "ready"
        : nativePath
        ? "pending"
        : "blocked"
    },
    {
      label: "Local Agent",
      value: status?.agentConnected
        ? "Vaultへ接続済み"
        : status?.agentManagedRunning
        ? "起動中"
        : "offline",
      state: status?.agentConnected ? "ready" : nativePath ? "pending" : "blocked"
    },
    {
      label: "Web AI",
      value: webReady
        ? "Remote MCP登録可"
        : hostedMode
        ? "pairing確認待ち"
        : "Hosted Relay未設定",
      state: webReady ? "ready" : nativePath ? "pending" : "blocked"
    }
  ];

  if (!nativePath) {
    return {
      tone: "blocked",
      title: "Desktop appでVaultを開く必要があります",
      summary:
        "ブラウザ表示ではRelayとAgentを起動できません。Vault本体はローカルに置き、AIへは確認済みContext Packだけを返します。",
      nextStep: "Desktop版を開いて暗号化Vaultを読み込みます。",
      issue: null,
      primaryAction: "open_desktop",
      items
    };
  }

  if (hostedMode && status?.agentConnected) {
    return {
      tone: "ready",
      title: "Web AIからContext Packを要求できます",
      summary:
        "Hosted Relayとのpairingを確認済みです。Relayは本文を保持せず、この端末のAgentが検索と承認待ちを処理します。",
      nextStep: "ChatGPTやClaude WebへRemote MCP connector情報を登録します。",
      issue: null,
      primaryAction: "copy_web_connector",
      items
    };
  }

  if (hostedMode) {
    return {
      tone: "attention",
      title: status?.agentManagedRunning
        ? "Hosted Relayのpairing確認待ちです"
        : "Hosted Relayへ接続するAgentが停止しています",
      summary:
        "Web上のAIが使う公開HTTPS入口は、pairing確認後だけ表示・コピーできます。短命URLはVaultに保存しません。",
      nextStep: hostedUrlEntered
        ? "Agent接続を再実行し、pairingが確認されたらWeb AIへ登録します。"
        : "Hosted Relayで短命Agent WebSocket URLを発行して貼り付けます。",
      issue,
      primaryAction: hostedUrlEntered ? "start_hosted_agent" : "refresh",
      items
    };
  }

  if (localReady) {
    return {
      tone: "ready",
      title: "同じ端末のAIからVaultを呼べます",
      summary:
        "Local MCP/Agentは接続済みです。Web AIで使う場合はHosted Relayをpairingし、普段使うAIにはContext Pack境界だけを登録します。",
      nextStep: "まずRequestsでContext Pack確認とコピーfallbackを試します。",
      issue: null,
      primaryAction: "open_requests",
      items
    };
  }

  if (status?.relayReachable && !status.relayManagedRunning) {
    return {
      tone: "attention",
      title: "外部Relayを検知しています",
      summary:
        "アプリが起動していないRelayには自動でAgentを接続しません。手動pairingか、外部Relay停止後のアプリ管理起動を選びます。",
      nextStep: "self-host運用なら手動pairingを続け、通常利用なら外部Relayを止めてAI連携を開始します。",
      issue,
      primaryAction: "refresh",
      items
    };
  }

  if (status?.relayReachable) {
    return {
      tone: "attention",
      title: "Relayは起動していますがAgent待ちです",
      summary:
        "AIからの要求入口は応答しています。Local Agentが接続すると、Vault検索とContext Pack生成をこの端末で実行できます。",
      nextStep: "AI連携をもう一度開始してAgent接続を戻します。",
      issue,
      primaryAction: "start_ai_access",
      items
    };
  }

  if (issue) {
    return {
      tone: "attention",
      title: "AI Accessの直近エラーがあります",
      summary:
        "RelayまたはAgentの起動確認で問題が出ています。Context Pack本文やVault本文は診断表示には含めません。",
      nextStep: "状態を更新し、必要ならAI連携をもう一度開始します。",
      issue,
      primaryAction: "refresh",
      items
    };
  }

  return {
    tone: "neutral",
    title: "AI連携は停止中です",
    summary:
      "普段使うAIから呼び出すにはRelayとAgentを起動します。保存済みFactは、確認済みContext PackになるまでAIへ渡りません。",
    nextStep: "AI連携を開始してLocal MCP用のRelayとAgentを起動します。",
    issue: null,
    primaryAction: "start_ai_access",
    items
  };
}

export function connectionDiagnosticSummaryBadge(
  diagnostic: Pick<ConnectionDiagnostic, "tone" | "items">
): { label: string; detail: string } {
  const readyCount = diagnostic.items.filter((item) => item.state === "ready").length;
  const blockedCount = diagnostic.items.filter((item) => item.state === "blocked").length;
  const totalCount = diagnostic.items.length;
  const detail = `${readyCount}/${totalCount} ready`;

  if (diagnostic.tone === "ready") {
    return { label: "Ready", detail };
  }
  if (diagnostic.tone === "blocked" || blockedCount > 0) {
    return { label: "利用不可", detail };
  }
  if (diagnostic.tone === "attention") {
    return { label: "要確認", detail };
  }
  return { label: "確認中", detail };
}

export function hostedRelayRegistrationReadiness(
  status: any | null,
  nativePath: string | null,
  hostedAgentWebsocketUrl: string,
  webMcpEndpoint: string | null
): HostedRelayRegistrationReadiness {
  const hostedPreview = hostedRelayMcpUrlFromAgentWs(hostedAgentWebsocketUrl);
  const urlEntered = hostedAgentWebsocketUrl.trim().length > 0;
  const validAgentUrl = Boolean(hostedPreview);
  const hostedMode = status?.relayMode === "hosted_agent";
  const confirmed = isHostedRelayConfirmed(status);
  const publicMcpReady = Boolean(webMcpEndpoint && isPublicHttpsUrl(webMcpEndpoint));
  const oauthMetadataReady = publicMcpReady;
  const items: ConnectionDiagnosticItem[] = [
    {
      label: "Desktop Vault",
      value: nativePath ? "この端末で開いている" : "Desktop appが必要",
      state: nativePath ? "ready" : "blocked"
    },
    {
      label: "短命Agent URL",
      value: validAgentUrl
        ? "WSS pairing URLを検証済み"
        : urlEntered
          ? "形式を確認してください"
          : "Hosted Relayで発行待ち",
      state: validAgentUrl ? "ready" : urlEntered ? "blocked" : "pending"
    },
    {
      label: "Relay pairing",
      value: confirmed
        ? "この端末のAgentを確認済み"
        : hostedMode && status?.agentManagedRunning
          ? "Agent接続を確認中"
          : "未確認",
      state: confirmed ? "ready" : nativePath ? "pending" : "blocked"
    },
    {
      label: "Public MCP URL",
      value: publicMcpReady
        ? "公開HTTPS URLを登録可能"
        : validAgentUrl
          ? "pairing後に表示"
          : "未生成",
      state: publicMcpReady ? "ready" : validAgentUrl ? "pending" : "blocked"
    },
    {
      label: "OAuth metadata",
      value: oauthMetadataReady
        ? "metadata URLを接続情報へ含めます"
        : "公開MCP URL確定後に生成",
      state: oauthMetadataReady ? "ready" : validAgentUrl ? "pending" : "blocked"
    },
    {
      label: "Data boundary",
      value: "Context PackだけをAIへ返す",
      state: "ready"
    }
  ];

  if (!nativePath) {
    return {
      tone: "blocked",
      title: "Desktop appでVaultを開いてください",
      summary:
        "Web AI登録には、この端末のVault Agentが必要です。ブラウザ表示だけではVaultをHosted Relayへpairingできません。",
      nextStep: "Desktop appを開いてからHosted Relayの短命URLを貼り付けます。",
      items
    };
  }

  if (urlEntered && !validAgentUrl) {
    return {
      tone: "blocked",
      title: "Agent URLの形式を確認してください",
      summary:
        "Hosted Relayが発行した `wss://.../agent/ws?pairing_code=...` だけを受け付けます。URL本文は保存しません。",
      nextStep: "Hosted Relayで新しい短命Agent WebSocket URLを発行し直します。",
      items
    };
  }

  if (confirmed && publicMcpReady) {
    return {
      tone: "ready",
      title: "Web AIへ登録できます",
      summary:
        "公開HTTPS Relayとのpairing確認済みです。ChatGPT/Claude WebにはRemote MCP接続情報を登録し、Vault処理はこの端末で行います。",
      nextStep: "Web AI用接続情報をコピーして、普段使うAIのConnector設定へ貼り付けます。",
      items
    };
  }

  if (validAgentUrl) {
    return {
      tone: "attention",
      title: hostedMode ? "pairing確認待ちです" : "Agent接続を開始できます",
      summary:
        "公開MCP URLは推定できますが、AIへ登録できるのはRelayがこの端末のAgentを確認した後です。",
      nextStep: "Hosted RelayへAgent接続を実行し、確認後にWeb AI接続情報をコピーします。",
      items
    };
  }

  return {
    tone: "neutral",
    title: "Hosted Relay URLを待っています",
    summary:
      "ChatGPT/Claude Webはlocalhostへ直接来られません。公開HTTPS Relayで短命Agent WebSocket URLを発行して貼り付けます。",
    nextStep: "self-hostのpairingコマンド、または運用中のHosted Relayから短命URLを発行します。",
    items
  };
}

export function webAiRegistrationGuides(
  readiness: HostedRelayRegistrationReadiness,
  webConnectorInfo: Record<string, unknown> | null
): WebAiRegistrationGuide[] {
  const ready = readiness.tone === "ready" && Boolean(webConnectorInfo);
  const status: ConnectionDiagnosticState = readiness.tone === "blocked" ? "blocked" : ready ? "ready" : "pending";
  const statusLabel = ready
    ? "登録情報をコピーできます"
    : readiness.tone === "blocked"
      ? "先にVault/Agentを確認"
      : "pairing完了待ち";
  const blockedAction = readiness.tone === "blocked" ? "Vault/Agentを確認" : "pairing後にコピー";
  const firstStep = ready
    ? "接続情報をコピー"
    : readiness.tone === "blocked"
      ? "Desktop appでVaultを開く"
      : "Hosted Relayのpairingを完了";

  return [
    {
      provider: "ChatGPT",
      status,
      statusLabel,
      steps: [firstStep, "ChatGPTに接続情報を貼り付け", "初回要求時にContext Packを確認"],
      actionLabel: ready ? "ChatGPT用JSONをコピー" : blockedAction,
      boundary: "ChatGPTへ渡るのは、確認済みContext Packの本文と出典snippetだけです。接続に失敗した場合は登録方式を切り替えられます。"
    },
    {
      provider: "Claude Web",
      status,
      statusLabel,
      steps: [firstStep, "Remote MCP connectorへ登録", "回答前のPack内容を確認"],
      actionLabel: ready ? "Claude用JSONをコピー" : blockedAction,
      boundary: "RelayはVault本文を保持せず、この端末のAgentが検索と承認待ちを処理します。"
    },
    {
      provider: "MCPなしのAI",
      status: "ready",
      statusLabel: "いつでも利用可",
      steps: ["RequestsでPackを作成", "内容を確認してコピー", "普段使うAIへ貼り付け"],
      actionLabel: "Requestsで確認・コピー",
      boundary: "MCP未接続でも、AIへ渡した内容をAuditで追える導線です。"
    }
  ];
}

export function aiAccessChecklistItems(
  status: any | null,
  nativePath: string | null
): Array<{ label: string; detail: string; state: "ready" | "pending" | "blocked" }> {
  return [
    {
      label: "Desktop Vault",
      detail: nativePath
        ? "暗号化Vaultをこの端末で開いています。"
        : "Desktop appで開くとRelayとAgentを管理できます。",
      state: nativePath ? "ready" : "blocked"
    },
    {
      label: "Relay endpoint",
      detail: status?.relayMode === "hosted_agent"
        ? status.agentConnected
          ? "Hosted HTTPS Relayとのpairingを確認済みです。"
          : "pairing確認後にAIへ登録できます。今は確認待ちです。"
        : status?.relayReachable
        ? "Remote MCPのHTTPS/HTTP入口が応答しています。OAuth metadataはCIMDとDCRを案内します。"
        : "AI連携を開始してMCP endpointを起動します。",
      state: status?.relayMode === "hosted_agent" ? status.agentConnected ? "ready" : "pending" : status?.relayReachable ? "ready" : nativePath ? "pending" : "blocked"
    },
    {
      label: "Local Agent",
      detail: status?.relayMode === "hosted_agent"
        ? status.agentConnected
          ? "この端末のAgentがHosted RelayのWebSocketへ接続済みです。"
          : "この端末のアプリを起動しています。Relayとの確認待ちです。"
        : status?.agentConnected
        ? "Vault検索とContext Pack生成をローカルで実行できます。"
        : "Agent接続後にAIからの要求をVault Coreへ渡せます。",
      state: status?.relayMode === "hosted_agent" ? status.agentConnected ? "ready" : "pending" : status?.agentConnected ? "ready" : nativePath ? "pending" : "blocked"
    },
    {
      label: "Streamable HTTP",
      detail: status?.relayReachable
        ? "POST JSON-RPC、GET SSE ready、MCP session、DELETE終了に対応しています。SSE再開はメタデータ限定で、AI本文やContext Pack本文は保存しません。"
        : "Relay起動後にSSE ready診断で確認できます。再開対応は/relay/stateで確認します。",
      state: status?.relayReachable ? "ready" : nativePath ? "pending" : "blocked"
    },
    {
      label: "Context Pack boundary",
      detail: "AIへ返すのは承認済みFactから作る短命Context Packだけです。",
      state: "ready"
    }
  ];
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

function makeRelayCommand(nativePath: string | null): string {
  const vaultPath =
    nativePath ?? "$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3";
  return [
    `LCV_RELAY_TOKEN=${localRelayToken}`,
    `LCV_RELAY_BIND=127.0.0.1:8765`,
    `LCV_RELAY_BASE_URL=${localRelayBaseUrl}`,
    `LCV_RELAY_TENANT_ID=local`,
    `LCV_RELAY_STATE_PATH="${makeRelayStatePath(nativePath)}"`,
    `LCV_RELAY_ALLOW_DIRECT_SIDECAR=0`,
    `LCV_MCP_COMMAND="${localMcpBinaryPath}"`,
    `LCV_VAULT_DB_PATH="${vaultPath}"`,
    `src-tauri/target/release/lcv-relay`
  ].join(" ");
}

function makePairingCommand(): string {
  return `curl -s -X POST ${localRelayBaseUrl}/pairing/start`;
}

function makeHostedPairingCurlTemplate(): string {
  return [
    "curl -fsS",
    "  -H 'Authorization: Bearer <LCV_RELAY_ADMIN_TOKEN>'",
    "  -X POST",
    "  https://relay.example.com/pairing/start"
  ].join(" \\\n");
}

function makeRelayHealthCheckCommand(): string {
  return `curl -fsS ${localRelayBaseUrl}/health`;
}

function makeRemoteMcpHeaderCheckCommand(): string {
  return [
    "curl -i -X POST",
    "  -H 'Content-Type: application/json'",
    "  -H 'Accept: application/json, text/event-stream'",
    "  -H 'MCP-Protocol-Version: 2025-11-25'",
    "  --data '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}'",
    `  ${localRelayUrl}`
  ].join(" \\\n");
}

function makeRemoteMcpSseCheckCommand(): string {
  return [
    "curl -i -N",
    "  -H 'Accept: text/event-stream'",
    "  -H 'MCP-Protocol-Version: 2025-11-25'",
    `  ${localRelayUrl}`
  ].join(" \\\n");
}

function makeRelayStatePath(nativePath: string | null): string {
  if (nativePath) {
    return nativePath.replace(/vault\.sqlite3$/, "relay-state.json");
  }
  return "$HOME/Library/Application Support/dev.life-context-vault.poc/relay-state.json";
}

function hostedRelayMcpUrlFromAgentWs(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "wss:") return null;
    if (url.username || url.password || url.hash) return null;
    if (url.pathname !== "/agent/ws") return null;
    if (!url.searchParams.get("pairing_code")) return null;
    if ([...url.searchParams.keys()].some((key) => key !== "pairing_code")) return null;
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = "/mcp";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isHostedRelayConfirmed(
  status: Pick<any, "agentConnected" | "relayMode"> | null
): boolean {
  return status?.relayMode === "hosted_agent" && Boolean(status.agentConnected);
}

export function canCopyAiMcpEndpoint(
  status: Pick<any, "agentConnected" | "relayMode"> | null
): boolean {
  return status?.relayMode !== "hosted_agent" || Boolean(status.agentConnected);
}

export function aiMcpEndpointDisplay(
  status: Pick<any, "agentConnected" | "relayMode"> | null,
  endpoint: string
): string {
  return canCopyAiMcpEndpoint(status) ? endpoint : "pairing確認後に表示";
}

export function webAiMcpEndpoint(
  status: Pick<any, "agentConnected" | "relayMode"> | null,
  endpoint: string
): string | null {
  if (status?.relayMode === "hosted_agent") {
    return status.agentConnected ? endpoint : null;
  }
  return isLocalhostUrl(endpoint) ? null : endpoint;
}

function makeAgentCommand(nativePath: string | null): string {
  const vaultPath =
    nativePath ?? "$HOME/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3";
  return [
    `LCV_AGENT_RELAY_WS="ws://127.0.0.1:8765/agent/ws?pairing_code=<pairingCode>"`,
    `LCV_MCP_COMMAND="${localMcpBinaryPath}"`,
    `LCV_VAULT_DB_PATH="${vaultPath}"`,
    `${localAgentBinaryPath}`
  ].join(" ");
}

function makeRemoteConnectorInfo(mcpServerUrl: string) {
  const baseUrl = relayBaseUrlFromMcpUrl(mcpServerUrl);
  return {
    mcpServerUrl,
    authorizationServerMetadata: `${baseUrl}/.well-known/oauth-authorization-server`,
    protectedResourceMetadata: `${baseUrl}/.well-known/oauth-protected-resource`,
    clientIdMetadataDocuments: "supported for allowed public PKCE clients; DCR remains available as fallback",
    dynamicClientRegistration: `${baseUrl}/oauth/register`,
    expectedOAuth: "CIMD or DCR + Authorization Code + PKCE S256 with resource-bound access tokens",
    relayStateStatus: `${baseUrl}/relay/state`,
    scopes: [
      "context_pack.request",
      "memory.propose",
      "policy.read",
      "request.status"
    ]
  };
}

function relayBaseUrlFromMcpUrl(mcpServerUrl: string): string {
  try {
    const url = new URL(mcpServerUrl);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return localRelayBaseUrl;
  }
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
