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
  AiAccessServiceStatus,
  BrowserCaptureHostInstallResult,
  ClaudeDesktopConfigInstallResult,
  LoginItemStatus,
  NativeDocumentExtractionCapabilities,
  NativeLegacyOfficeProviderCandidate,
  NativeOcrProviderCandidate,
  addNativePassiveCaptureEvent,
  addNativeSourceWithCandidates,
  approveNativeCandidate,
  confirmNativeContextPack,
  createNativeContextPackRequest,
  denyNativeContextPackRequest,
  detectNativeLegacyOfficeProviderCandidates,
  detectNativeOcrProviderCandidates,
  extractNativeDocumentText,
  getAiAccessServiceStatus,
  getClaudeDesktopConfigTemplate,
  getLoginItemStatus,
  getNativeDocumentExtractionCapabilities,
  getNativeVaultPath,
  handoffConfirmedContextPackToRelay,
  installChromeCaptureHostManifest,
  installClaudeDesktopConfig,
  installLoginItem,
  loadNativeVaultSnapshot,
  saveNativeVault,
  searchNativeFacts,
  startAiAccessAgentForRelay,
  startAiAccessServices,
  stopAiAccessServices,
  updateNativeAccessPolicy,
  updateNativeCandidateStatus,
  updateNativeContextPackItemVisibility,
  updateNativeFactLifecycle,
  updateNativeFactMetadata,
  updateNativePassiveCaptureSettings,
  updateNativeSourceMetadata,
  updateNativeSourceBody,
  updateNativeSourceLifecycle,
  uninstallLoginItem
} from "./nativeStorage";
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
  | "audit"
  | "settings";

type OnboardingStep = {
  title: string;
  body: string;
  status: "done" | "current" | "blocked";
  actionLabel: string;
  action?: () => void;
  disabled?: boolean;
};

type SearchMode = "native_fts" | "browser_fallback" | "loading";

type UploadFeedback = {
  tone: "ready" | "attention";
  title: string;
  body: string;
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
  };
  sensitivitySummary: string;
  newestSourceAt?: string;
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
  const [captureClient, setCaptureClient] = useState<ConnectorKind>("chatgpt");
  const [captureConversationId, setCaptureConversationId] = useState("demo-thread");
  const [captureText, setCaptureText] = useState("");
  const [captureExtensionId, setCaptureExtensionId] = useState("");
  const [captureHostInstallBusy, setCaptureHostInstallBusy] = useState(false);
  const [captureHostInstallResult, setCaptureHostInstallResult] =
    useState<BrowserCaptureHostInstallResult | null>(null);
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
  const [aiServiceStatus, setAiServiceStatus] = useState<AiAccessServiceStatus | null>(null);
  const [aiServiceBusy, setAiServiceBusy] = useState(false);
  const [hostedAgentWebsocketUrl, setHostedAgentWebsocketUrl] = useState("");
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

  useEffect(() => {
    nativeRevisionRef.current = nativeRevision;
  }, [nativeRevision]);

  useEffect(() => {
    saveRuntimePreferences(runtimePreferences);
  }, [runtimePreferences]);

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
    if (
      !storageReady ||
      !nativePath ||
      !runtimePreferences.autoStartAiAccess ||
      autoStartAttemptedRef.current
    ) {
      return;
    }
    autoStartAttemptedRef.current = true;
    let cancelled = false;
    async function autoStartAiAccess() {
      try {
        const current = await getAiAccessServiceStatus();
        if (cancelled) return;
        if (current?.agentConnected) {
          setAiServiceStatus(current);
          return;
        }
        setAiServiceBusy(true);
        const status = await startAiAccessServices();
        if (cancelled) return;
        setAiServiceStatus(status);
        setNotice(
          status?.agentConnected
            ? "設定に従ってAI Access Serviceを自動起動しました。"
            : "AI Access Serviceの自動起動を開始しました。"
        );
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : "AI Access Serviceの自動起動に失敗しました。");
          void getAiAccessServiceStatus().then(setAiServiceStatus).catch(() => undefined);
        }
      } finally {
        if (!cancelled) setAiServiceBusy(false);
      }
    }
    void autoStartAiAccess();
    return () => {
      cancelled = true;
    };
  }, [nativePath, runtimePreferences.autoStartAiAccess, storageReady]);

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
      .catch((error) => console.warn("Native vault save failed", error));
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
    if (!storageReady) return;
    let cancelled = false;
    async function refreshStatus() {
      try {
        const status = await getAiAccessServiceStatus();
        if (!cancelled) setAiServiceStatus(status);
      } catch (error) {
        if (!cancelled) {
          setAiServiceStatus((current) =>
            current
              ? {
                  ...current,
                  lastError: error instanceof Error ? error.message : "AI Access Service status failed"
                }
              : current
          );
        }
      }
    }
    void refreshStatus();
    const interval = window.setInterval(refreshStatus, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [storageReady]);

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
      setNotice("消去できるCapture本文はありません。");
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

  async function tryRelayHandoff(nextState: VaultState, requestId: string | null | undefined) {
    if (!nativePath || !requestId) {
      return { status: "skipped" as const };
    }
    const request = nextState.contextPackRequests.find((item) => item.id === requestId);
    if (!request) {
      return { status: "skipped" as const };
    }
    try {
      const handoff = await handoffConfirmedContextPackToRelay({
        clientId: request.clientId,
        requestId: request.id
      });
      if (handoff?.stored) {
        if (handoff.state) {
          nativeRevisionRef.current = handoff.updatedAt;
          setNativeRevision(handoff.updatedAt);
          setState(handoff.state);
        }
        return { status: "stored" as const, ttlSeconds: handoff.ttlSeconds };
      }
      return { status: "skipped" as const };
    } catch (error) {
      return {
        status: "failed" as const,
        message: error instanceof Error ? error.message : "Relay handoffに失敗しました。"
      };
    }
  }

  function relayHandoffNotice(outcome: Awaited<ReturnType<typeof tryRelayHandoff>>): string {
    if (outcome.status === "stored") {
      const minutes = outcome.ttlSeconds ? Math.max(1, Math.round(outcome.ttlSeconds / 60)) : 10;
      return `Context Packを承認し、Relayへ${minutes}分の短命handoffを登録しました。外部AIはget_request_statusで取得できます。`;
    }
    if (outcome.status === "failed") {
      return `Context Packを承認しました。Relay handoffは未完了です: ${outcome.message}`;
    }
    return "Context Packを承認しました。外部AIはget_request_statusで取得できます。";
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
      const handoff = await tryRelayHandoff(state, request.id);
      setNotice(
        handoff.status !== "skipped"
          ? relayHandoffNotice(handoff)
          : "このContext PackはすでにAIへ返せる状態です。"
      );
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
          const handoff = await tryRelayHandoff(updated.state, updated.requestId ?? request?.id);
          setNotice(relayHandoffNotice(handoff));
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
    apply(confirmedState, "Context Packを承認しました。外部AIはget_request_statusで取得できます。");
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
    const copied = await copyText(
      JSON.stringify(makeAiContextPackPayload(payloadPack), null, 2),
      shouldConfirm
        ? "Context Packを承認し、AI向けペイロードをコピーしました。"
        : "AI向けContext Packをコピーしました。"
    );
    if (copied) {
      setState((current) =>
        recordContextPackDelivery(current, payloadPack.id, {
          channel: "clipboard_copy",
          status: "copied"
        })
      );
    }
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

  function updateCapture(settings: Partial<PassiveCaptureSettings>) {
    void updateCaptureThroughCore(settings);
  }

  async function updateCaptureThroughCore(settings: Partial<PassiveCaptureSettings>) {
    if (nativePath) {
      try {
        const updated = await updateNativePassiveCaptureSettings(settings);
        if (updated) {
          nativeRevisionRef.current = updated.updatedAt;
          setNativeRevision(updated.updatedAt);
          setState(updated.state);
          setNotice("Capture設定をVault Coreで保存しました。");
          return;
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Vault CoreでCapture設定を保存できませんでした。");
        return;
      }
    }
    apply(updatePassiveCaptureSettings(state, settings), "Capture設定を更新しました。");
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

  function simulatePassiveCapture() {
    void simulatePassiveCaptureThroughCore();
  }

  async function simulatePassiveCaptureThroughCore() {
    if (!captureText.trim()) {
      setNotice("Captureする会話断片を入力してください。");
      return;
    }
    const conversationId = captureConversationId || "demo-thread";
    const url = captureUrlForClient(captureClient, conversationId);
    if (nativePath) {
      try {
        const saved = await saveNativeVault(state, nativeRevisionRef.current);
        if (saved?.conflict && saved.currentState) {
          const mergedState = mergeVaultStates(saved.currentState, state);
          nativeRevisionRef.current = saved.currentUpdatedAt;
          setNativeRevision(saved.currentUpdatedAt);
          setState(mergedState);
          setNotice("外部AI接続からの更新を取り込みました。Captureをもう一度実行してください。");
          return;
        }
        if (saved?.updatedAt) {
          nativeRevisionRef.current = saved.updatedAt;
          setNativeRevision(saved.updatedAt);
        }
        const captured = await addNativePassiveCaptureEvent({
          sourceClient: captureClient,
          conversationId,
          url,
          text: captureText,
          pageTitle: "Manual capture",
          selected: true
        });
        if (!captured) {
          setNotice("Desktop app外ではローカルCaptureとして処理します。");
        } else {
          nativeRevisionRef.current = captured.updatedAt;
          setNativeRevision(captured.updatedAt);
          setState(captured.state);
          setNotice(
            captured.accepted
              ? `CaptureからMemory候補を${captured.candidateIds.length}件生成しました。承認されるまでAIには使われません。`
              : captured.message
          );
          if (captured.accepted) {
            setCaptureText("");
            setView("inbox");
          }
          return;
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Vault CoreでCaptureを保存できませんでした。");
        return;
      }
    }
    const next = addPassiveCaptureEvent(state, {
      sourceClient: captureClient,
      conversationId,
      url,
      text: captureText
    });
    apply(next, state.passiveCaptureSettings.enabled ? "CaptureからMemory候補を生成しました。" : "Captureは停止中です。");
    if (state.passiveCaptureSettings.enabled) {
      setCaptureText("");
      setView("inbox");
    }
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
      const payload = await exportEncryptedBackup(state, backupPassphrase);
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
      const restored = await importEncryptedBackup(backupText, backupPassphrase);
      setRestorePreview(makeRestorePreview(restored));
      setRestoreConfirmText("");
      setNotice("バックアップを読み取りました。件数を確認し、復元する場合はRESTOREと入力してください。");
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
      const restored = await importEncryptedBackup(backupText, backupPassphrase);
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

  async function refreshAiAccess() {
    try {
      const status = await getAiAccessServiceStatus();
      setAiServiceStatus(status);
      setNotice(status ? "AI Access Serviceの状態を更新しました。" : "Desktop appでのみAI Access Serviceを管理できます。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI Access Serviceの状態確認に失敗しました。");
    }
  }

  async function startAiAccess() {
    setAiServiceBusy(true);
    try {
      const status = await startAiAccessServices();
      setAiServiceStatus(status);
      setNotice(status?.agentConnected ? "AI Access Serviceを起動しました。" : "AI Access Serviceの起動を開始しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI Access Serviceの起動に失敗しました。");
      void getAiAccessServiceStatus().then(setAiServiceStatus).catch(() => undefined);
    } finally {
      setAiServiceBusy(false);
    }
  }

  async function startHostedRelayAgent() {
    const trimmedUrl = hostedAgentWebsocketUrl.trim();
    if (!trimmedUrl || !hostedRelayMcpUrlFromAgentWs(trimmedUrl)) {
      setNotice("Hosted Relayで発行したwss://のAgent WebSocket URLを入力してください。");
      return;
    }
    setAiServiceBusy(true);
    try {
      const status = await startAiAccessAgentForRelay(trimmedUrl);
      setAiServiceStatus(status);
      setHostedAgentWebsocketUrl("");
      setNotice(
        status?.agentConnected
          ? "Hosted Relayとのpairingを確認しました。Web AIへMCP URLを登録できます。"
          : status?.agentManagedRunning
          ? "Hosted Relayへ接続する端末アプリを起動しました。Relay側の確認を待っています。"
          : "Hosted Relay Agentの接続を開始しました。"
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Hosted Relay Agentの接続に失敗しました。");
      void getAiAccessServiceStatus().then(setAiServiceStatus).catch(() => undefined);
    } finally {
      setAiServiceBusy(false);
    }
  }

  async function stopAiAccess() {
    setAiServiceBusy(true);
    try {
      const status = await stopAiAccessServices();
      setAiServiceStatus(status);
      setNotice("AI Access Serviceを停止しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "AI Access Serviceの停止に失敗しました。");
      void getAiAccessServiceStatus().then(setAiServiceStatus).catch(() => undefined);
    } finally {
      setAiServiceBusy(false);
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

  async function installCaptureHostManifest() {
    setCaptureHostInstallBusy(true);
    setCaptureHostInstallResult(null);
    try {
      const result = await installChromeCaptureHostManifest(captureExtensionId);
      setCaptureHostInstallResult(result);
      if (!result) {
        setNotice("Desktop appでのみChrome Native Messaging hostをインストールできます。");
      } else if (result.alreadyConfigured) {
        setNotice("Chrome Native Messaging hostはすでに最新です。");
      } else {
        setNotice("Chrome Native Messaging hostをインストールしました。拡張popupからCaptureできます。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Chrome Native Messaging hostのインストールに失敗しました。");
    } finally {
      setCaptureHostInstallBusy(false);
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
          <NavButton icon={<Home size={18} />} label="Home" active={view === "home"} onClick={() => setView("home")} />
          <NavButton icon={<Inbox size={18} />} label="Inbox" active={view === "inbox"} onClick={() => setView("inbox")} badge={activeCandidates.length} />
          <NavButton icon={<FileText size={18} />} label="Sources" active={view === "sources"} onClick={() => setView("sources")} />
          <NavButton icon={<Plug size={18} />} label="Connections" active={view === "connections"} onClick={() => setView("connections")} />
          <NavButton
            icon={<MessageSquare size={18} />}
            label="Requests"
            active={view === "requests"}
            onClick={() => setView("requests")}
            badge={state.contextPackRequests.filter((request) => requestNeedsUserAction(request)).length}
          />
          <NavButton icon={<Search size={18} />} label="Search" active={view === "search"} onClick={() => setView("search")} badge={reviewFacts.length} />
          <NavButton icon={<Activity size={18} />} label="Audit" active={view === "audit"} onClick={() => setView("audit")} />
          <NavButton icon={<Settings size={18} />} label="Settings" active={view === "settings"} onClick={() => setView("settings")} />
        </nav>
        <div className="sidebar-stats">
          <Metric label="Sources" value={state.sources.length} />
          <Metric label="Facts" value={activeFacts.length} />
          <Metric label="Requests" value={state.contextPackRequests.length} />
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
              <button className="notice" onClick={() => setNotice("")} type="button">
                {notice}
              </button>
            )}
          </div>
        </header>

        {view === "home" && (
          <HomeView
            facts={activeFacts}
            candidates={activeCandidates}
            connectors={state.connectorSessions}
            captureSettings={state.passiveCaptureSettings}
            sources={state.sources}
            requests={state.contextPackRequests}
            nativePath={nativePath}
            aiServiceStatus={aiServiceStatus}
            aiServiceBusy={aiServiceBusy}
            setup={setup}
            setSetup={setSetup}
            submitBackground={submitBackground}
            startAiAccess={startAiAccess}
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
          <ConnectionsView
            connectors={state.connectorSessions}
            policies={state.accessPolicies}
            sources={state.sources}
            passiveCaptureEvents={state.passiveCaptureEvents}
            captureSettings={state.passiveCaptureSettings}
            updateCapture={updateCapture}
            updatePolicy={updatePolicy}
            purgePassiveCaptureEvent={purgePassiveCaptureEvent}
            purgeAllPassiveCaptures={purgeAllPassiveCaptures}
            nativePath={nativePath}
            aiServiceStatus={aiServiceStatus}
            aiServiceBusy={aiServiceBusy}
            runtimePreferences={runtimePreferences}
            updateRuntimePreference={updateRuntimePreference}
            loginItemStatus={loginItemStatus}
            loginItemBusy={loginItemBusy}
            claudeInstallBusy={claudeInstallBusy}
            claudeInstallResult={claudeInstallResult}
            claudeConfig={claudeConfig}
            startAiAccess={startAiAccess}
            startHostedRelayAgent={startHostedRelayAgent}
            stopAiAccess={stopAiAccess}
            refreshAiAccess={refreshAiAccess}
            hostedAgentWebsocketUrl={hostedAgentWebsocketUrl}
            setHostedAgentWebsocketUrl={setHostedAgentWebsocketUrl}
            refreshLoginItem={refreshLoginItem}
            enableLoginItem={enableLoginItem}
            disableLoginItem={disableLoginItem}
            installClaudeConfig={installClaudeConfig}
            copyText={copyText}
            captureClient={captureClient}
            setCaptureClient={setCaptureClient}
            captureConversationId={captureConversationId}
            setCaptureConversationId={setCaptureConversationId}
            captureText={captureText}
            setCaptureText={setCaptureText}
            captureExtensionId={captureExtensionId}
            setCaptureExtensionId={setCaptureExtensionId}
            captureHostInstallBusy={captureHostInstallBusy}
            captureHostInstallResult={captureHostInstallResult}
            installCaptureHostManifest={installCaptureHostManifest}
            simulatePassiveCapture={simulatePassiveCapture}
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
        {view === "audit" && (
          <AuditView events={state.auditEvents} />
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
  active,
  onClick,
  badge
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      aria-label={label}
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
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HomeView({
  facts,
  candidates,
  connectors,
  captureSettings,
  sources,
  requests,
  nativePath,
  aiServiceStatus,
  aiServiceBusy,
  setup,
  setSetup,
  submitBackground,
  startAiAccess,
  seedDemo,
  goInbox,
  goSources,
  goRequests,
  goConnections
}: {
  facts: ApprovedFact[];
  candidates: MemoryCandidate[];
  connectors: ConnectorSession[];
  captureSettings: PassiveCaptureSettings;
  sources: VaultState["sources"];
  requests: ContextPackRequest[];
  nativePath: string | null;
  aiServiceStatus: AiAccessServiceStatus | null;
  aiServiceBusy: boolean;
  setup: BackgroundSetupInput;
  setSetup: (input: BackgroundSetupInput) => void;
  submitBackground: () => void;
  startAiAccess: () => void;
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
  const aiAccessReady = Boolean(aiServiceStatus?.agentConnected);
  const requestTried = requests.length > 0;
  const accessReadiness = aiAccessReadinessCopy(aiServiceStatus, nativePath);
  const pendingRequestCount = requests.filter((request) => requestNeedsUserAction(request)).length;
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
      actionLabel: backgroundStarted ? "Sourceを見る" : "Source追加",
      action: goSources
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
      title: "AI Accessを起動する",
      body: accessReadiness.body,
      status: aiAccessReady ? "done" : nativePath ? "current" : "blocked",
      actionLabel: aiAccessReady ? "Connectionsを見る" : nativePath ? "起動する" : "Desktopで開く",
      action: aiAccessReady || !nativePath ? goConnections : startAiAccess,
      disabled: aiServiceBusy
    },
    {
      title: "Context Packを確認する",
      body: requestTried
        ? `${requests.length}件のContext Request履歴があります。`
        : "AIへ渡す最小文脈を確認してから回答を作ります。",
      status: requestTried ? "done" : approvedContextReady ? "current" : "blocked",
      actionLabel: "Requestsを開く",
      action: goRequests
    }
  ];
  const nextAction = (() => {
    if (candidates.length > 0) {
      return {
        title: `${candidates.length}件の候補を確認`,
        body: "保存する生活文脈だけをFactにします。承認前の候補はAIには渡りません。",
        label: "Inboxで確認",
        action: goInbox,
        icon: <Inbox size={18} />
      };
    }
    if (!backgroundStarted) {
      return {
        title: "生活背景を追加",
        body: "呼び名、制約、いま動いている生活領域からMemory Inbox候補を作ります。",
        label: "入力欄へ",
        action: focusSetup,
        icon: <Sparkles size={18} />
      };
    }
    if (pendingRequestCount > 0) {
      return {
        title: `${pendingRequestCount}件のContext Packを確認`,
        body: "外部AIに渡る最小文脈を見て、不要なFactを外してから承認できます。",
        label: "Requestsで確認",
        action: goRequests,
        icon: <MessageSquare size={18} />
      };
    }
    if (!aiAccessReady) {
      return {
        title: nativePath ? "AI Accessを起動" : "DesktopでAI Accessを有効化",
        body: accessReadiness.body,
        label: nativePath ? "AI Accessを起動" : "Connectionsを見る",
        action: nativePath ? startAiAccess : goConnections,
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
              disabled={aiServiceBusy && nextAction.action === startAiAccess}
              onClick={nextAction.action}
              type="button"
            >
              {nextAction.icon}
              {nextAction.label}
            </button>
          </div>
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

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI access</p>
            <h3>普段使うAIとの接続</h3>
          </div>
          <button className="secondary-button" onClick={goConnections} type="button">
            <Plug size={16} />
            Open
          </button>
        </div>
        <div className="connection-list compact">
          {connectors.slice(0, 4).map((connector) => (
            <div className="connection-row" key={connector.id}>
              <div>
                <strong>{connector.clientName}</strong>
                <span>{connector.transport}</span>
              </div>
              <Badge>{connector.status}</Badge>
            </div>
          ))}
        </div>
        <div className={captureSettings.enabled ? "capture-strip enabled" : "capture-strip"}>
          {captureSettings.enabled ? <Radio size={16} /> : <PauseCircle size={16} />}
          <span>{captureSettings.enabled ? "Passive Capture is on" : "Passive Capture is paused"}</span>
        </div>
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
          <EmptyState
            title="まだ背景情報がありません"
            body="ガイド入力かデモデータから始められます。保存前に必ずMemory Inboxで確認します。"
            action={<button className="primary-button" onClick={seedDemo} type="button"><Sparkles size={16} />デモ投入</button>}
          />
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
                  <span>この候補で古いFactを置き換える場合だけ選択します。置き換えたFactはAI候補から外れ、履歴に残ります。</span>
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
  editSourceBody
}: {
  sources: VaultState["sources"];
  candidates: VaultState["candidates"];
  facts: VaultState["facts"];
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
}) {
  const [isDragActive, setIsDragActive] = useState(false);
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
      </div>

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
            const linkedFactCountValue = facts.filter((fact) => fact.sourceIds.includes(source.id)).length;
            return (
              <SourceRow
                changeSourceLifecycle={changeSourceLifecycle}
                editSourceMetadata={editSourceMetadata}
                editSourceBody={editSourceBody}
                key={source.id}
                linkedCandidateCount={linkedCandidateCount}
                linkedFactCount={linkedFactCountValue}
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
  changeSourceLifecycle,
  editSourceMetadata,
  editSourceBody
}: {
  source: VaultState["sources"][number];
  linkedCandidateCount: number;
  linkedFactCount: number;
  changeSourceLifecycle: (sourceId: string, action: SourceLifecycleAction) => void;
  editSourceMetadata: (sourceId: string, input: SourceMetadataUpdate) => Promise<boolean>;
  editSourceBody: (sourceId: string, input: SourceBodyUpdate) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<SourceMetadataUpdate | null>(null);
  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const retentionLabel = sourceRetentionLabel(source);
  const canPromote = Boolean(source.retentionUntil);

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
            </div>
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
            onClick={() => changeSourceLifecycle(source.id, "purge_body")}
            type="button"
          >
            <X size={16} />
            本文消去
          </button>
        )}
      </div>
    </div>
  );
}

function ConnectionsView({
  connectors,
  policies,
  sources,
  passiveCaptureEvents,
  captureSettings,
  updateCapture,
  updatePolicy,
  purgePassiveCaptureEvent,
  purgeAllPassiveCaptures,
  nativePath,
  aiServiceStatus,
  aiServiceBusy,
  runtimePreferences,
  updateRuntimePreference,
  loginItemStatus,
  loginItemBusy,
  claudeInstallBusy,
  claudeInstallResult,
  claudeConfig,
  startAiAccess,
  startHostedRelayAgent,
  stopAiAccess,
  refreshAiAccess,
  hostedAgentWebsocketUrl,
  setHostedAgentWebsocketUrl,
  refreshLoginItem,
  enableLoginItem,
  disableLoginItem,
  installClaudeConfig,
  copyText,
  captureClient,
  setCaptureClient,
  captureConversationId,
  setCaptureConversationId,
  captureText,
  setCaptureText,
  captureExtensionId,
  setCaptureExtensionId,
  captureHostInstallBusy,
  captureHostInstallResult,
  installCaptureHostManifest,
  simulatePassiveCapture
}: {
  connectors: ConnectorSession[];
  policies: VaultState["accessPolicies"];
  sources: VaultState["sources"];
  passiveCaptureEvents: PassiveCaptureEvent[];
  captureSettings: PassiveCaptureSettings;
  updateCapture: (settings: Partial<PassiveCaptureSettings>) => void;
  updatePolicy: (
    clientId: string,
    settings: Partial<Pick<AccessPolicy, "sensitivityCeiling" | "requiresApprovalAbove" | "passiveCaptureAllowed" | "domainAllowlist">>
  ) => void;
  purgePassiveCaptureEvent: (eventId: string) => void;
  purgeAllPassiveCaptures: () => void;
  nativePath: string | null;
  aiServiceStatus: AiAccessServiceStatus | null;
  aiServiceBusy: boolean;
  runtimePreferences: RuntimePreferences;
  updateRuntimePreference: (next: Partial<RuntimePreferences>) => void;
  loginItemStatus: LoginItemStatus | null;
  loginItemBusy: boolean;
  claudeInstallBusy: boolean;
  claudeInstallResult: ClaudeDesktopConfigInstallResult | null;
  claudeConfig: string;
  startAiAccess: () => void;
  startHostedRelayAgent: () => void;
  stopAiAccess: () => void;
  refreshAiAccess: () => void;
  hostedAgentWebsocketUrl: string;
  setHostedAgentWebsocketUrl: (value: string) => void;
  refreshLoginItem: () => void;
  enableLoginItem: () => void;
  disableLoginItem: () => void;
  installClaudeConfig: () => void;
  copyText: (value: string, message: string) => void;
  captureClient: ConnectorKind;
  setCaptureClient: (value: ConnectorKind) => void;
  captureConversationId: string;
  setCaptureConversationId: (value: string) => void;
  captureText: string;
  setCaptureText: (value: string) => void;
  captureExtensionId: string;
  setCaptureExtensionId: (value: string) => void;
  captureHostInstallBusy: boolean;
  captureHostInstallResult: BrowserCaptureHostInstallResult | null;
  installCaptureHostManifest: () => void;
  simulatePassiveCapture: () => void;
}) {
  const accessReadiness = aiAccessReadinessCopy(aiServiceStatus, nativePath);
  const aiAccessChecklist = aiAccessChecklistItems(aiServiceStatus, nativePath);
  const mcpEndpoint = aiServiceStatus?.mcpServerUrl ?? localRelayUrl;
  const hostedRelayMcpPreview = hostedRelayMcpUrlFromAgentWs(hostedAgentWebsocketUrl);
  const hostedRelayConfirmed = isHostedRelayConfirmed(aiServiceStatus);
  const canCopyMcpEndpoint = canCopyAiMcpEndpoint(aiServiceStatus);
  const mcpEndpointDisplay = aiMcpEndpointDisplay(aiServiceStatus, mcpEndpoint);
  const webMcpEndpoint = webAiMcpEndpoint(aiServiceStatus, mcpEndpoint);
  const webConnectorInfo = webMcpEndpoint ? makeRemoteConnectorInfo(webMcpEndpoint) : null;
  const currentConnectorInfo = canCopyMcpEndpoint ? makeRemoteConnectorInfo(mcpEndpoint) : null;
  const captureExtensionIdReady = isLikelyChromeExtensionId(captureExtensionId);
  const recentCaptures = [...passiveCaptureEvents]
    .sort((left, right) => Date.parse(right.capturedAt) - Date.parse(left.capturedAt))
    .slice(0, 6);
  const purgeableCaptureCount = passiveCaptureSourceIdsForEvents(passiveCaptureEvents, sources).length;
  const [allowedSitesDraft, setAllowedSitesDraft] = useState(captureSettings.allowedSites.join(", "));

  useEffect(() => {
    setAllowedSitesDraft(captureSettings.allowedSites.join(", "));
  }, [captureSettings.allowedSites]);

  const cautiousDomains = policyDomainOptions.filter(
    (domain) =>
      ![
        "identity_and_profile",
        "health_and_care",
        "finance_and_benefits",
        "constraints_and_accessibility"
      ].includes(domain)
  );

  function domainsForPolicy(policy?: AccessPolicy): LifeContextDomain[] {
    return policy && policy.domainAllowlist.length > 0 ? policy.domainAllowlist : cautiousDomains;
  }

  function togglePolicyDomain(clientId: string, policy: AccessPolicy | undefined, domain: LifeContextDomain) {
    const current = domainsForPolicy(policy);
    const next = current.includes(domain)
      ? current.filter((item) => item !== domain)
      : [...current, domain];
    if (next.length === 0) return;
    updatePolicy(clientId, { domainAllowlist: next });
  }

  function setPolicyDomains(clientId: string, domains: LifeContextDomain[]) {
    if (domains.length === 0) return;
    updatePolicy(clientId, { domainAllowlist: domains });
  }

  return (
    <section className="view-grid connections-grid">
      <div className={`panel wide ai-access-quickstart ${accessReadiness.tone}`}>
        <div className="readiness-main">
          <div className="readiness-icon">
            {accessReadiness.tone === "ready" ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
          </div>
          <div>
            <p className="eyebrow">AI Access</p>
            <h3>{accessReadiness.title}</h3>
            <p>{accessReadiness.body}</p>
          </div>
        </div>
        <div className="service-actions ai-access-primary-actions">
          <button
            className="primary-button"
            disabled={!nativePath || aiServiceBusy}
            onClick={startAiAccess}
            type="button"
          >
            <PlayCircle size={16} />
            Start AI Access
          </button>
          <button
            className="secondary-button"
            disabled={!nativePath || aiServiceBusy}
            onClick={refreshAiAccess}
            type="button"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          <button
            className="secondary-button"
            disabled={!canCopyMcpEndpoint}
            onClick={() => copyText(mcpEndpoint, "MCP URLをコピーしました。")}
            type="button"
          >
            <Clipboard size={16} />
            Copy URL
          </button>
          <button
            className="danger-button"
            disabled={!nativePath || aiServiceBusy || (!aiServiceStatus?.relayManagedRunning && !aiServiceStatus?.agentManagedRunning)}
            onClick={stopAiAccess}
            type="button"
          >
            <PauseCircle size={16} />
            Stop managed
          </button>
        </div>
      </div>

      <div className="panel wide ai-connection-guide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Connect Your AI</p>
            <h3>普段使うAIからContext Packを呼ぶ</h3>
          </div>
          <Plug size={18} />
        </div>
        <div className="connection-wizard-grid">
          <article className={webConnectorInfo ? "connection-wizard-card ready" : "connection-wizard-card attention"}>
            <div className="wizard-card-heading">
              <Radio size={18} />
              <div>
                <strong>ChatGPT / Claude Web</strong>
                <span>
                  {webConnectorInfo
                    ? hostedRelayConfirmed
                      ? "Hosted Relayを登録できます"
                      : "Remote MCPで接続できます"
                    : hostedRelayMcpPreview
                    ? "pairing確認後に登録できます"
                    : "Hosted HTTPS Relayを先に用意します"}
                </span>
              </div>
            </div>
            <p>
              Web上のAIはこのMacのlocalhostへ直接アクセスできません。下のHosted Relay Agentでこの端末をpairingし、AIには公開HTTPSのMCP URLだけを登録します。
            </p>
            <div className="service-actions">
              <button
                className="secondary-button"
                disabled={!webConnectorInfo}
                onClick={() => {
                  if (!webConnectorInfo) return;
                  copyText(JSON.stringify(webConnectorInfo, null, 2), "Web AI用のRemote MCP connector情報をコピーしました。");
                }}
                type="button"
              >
                <Clipboard size={16} />
                Web AI用接続情報をコピー
              </button>
            </div>
            {!webConnectorInfo ? (
              <p className="muted">Hosted RelayのAgent WebSocket URLを貼ると、ChatGPT/Claudeへ登録するMCP URLを確認できます。</p>
            ) : null}
          </article>
          <article className={nativePath ? "connection-wizard-card ready" : "connection-wizard-card attention"}>
            <div className="wizard-card-heading">
              <Plug size={18} />
              <div>
                <strong>Claude Desktop / local AI</strong>
                <span>{nativePath ? "この端末のVaultへ接続できます" : "Desktop appで有効になります"}</span>
              </div>
            </div>
            <p>同じ端末のAIにはLocal MCPを使います。Raw Sourceや未承認候補は公開せず、回答前にContext Packを確認できます。</p>
            <div className="service-actions">
              <button
                className="primary-button"
                disabled={!nativePath || claudeInstallBusy}
                onClick={installClaudeConfig}
                type="button"
              >
                <Plug size={16} />
                Claude Desktopへ追加
              </button>
            </div>
          </article>
          <article className={captureSettings.enabled ? "connection-wizard-card ready" : "connection-wizard-card attention"}>
            <div className="wizard-card-heading">
              {captureSettings.enabled ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
              <div>
                <strong>AI会話のCapture</strong>
                <span>{captureSettings.enabled ? "許可サイトだけ候補化します" : "停止中です"}</span>
              </div>
            </div>
            <p>ブラウザ拡張や手動入力から会話断片を取り込みます。保存されるのは未承認候補で、Fact化とAI送信は別の確認です。</p>
            <div className="service-actions">
              <button
                className={captureSettings.enabled ? "danger-button" : "primary-button"}
                onClick={() => updateCapture({ enabled: !captureSettings.enabled })}
                type="button"
              >
                {captureSettings.enabled ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
                {captureSettings.enabled ? "Captureを一時停止" : "Captureを開始"}
              </button>
            </div>
          </article>
          <article className="connection-wizard-card ready">
            <div className="wizard-card-heading">
              <Clipboard size={18} />
              <div>
                <strong>コピーFallback</strong>
                <span>どのAIでも使えます</span>
              </div>
            </div>
            <p>RequestsでContext Packを確認してから本文をコピーします。MCP接続前でも、渡した内容をAuditで追える導線です。</p>
            <div className="service-actions">
              <button
                className="secondary-button"
                disabled={!canCopyMcpEndpoint}
                onClick={() => copyText(mcpEndpoint, "MCP URLをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                現在の入口をコピー
              </button>
            </div>
          </article>
        </div>
      </div>

      <div className="panel wide hosted-relay-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Hosted Relay Agent</p>
            <h3>ChatGPT / Claude Web用の公開Relayへ接続</h3>
          </div>
          <Radio size={18} />
        </div>
        <div className="hosted-relay-grid">
          <div className="hosted-relay-copy">
            <div className="trust-note">
              <ShieldCheck size={16} />
              <span>
                Hosted Relayが発行した短命Agent WebSocket URLだけを使います。URLは保存せず、Vault本体・Raw Source・未承認候補はRelayへ置きません。
              </span>
            </div>
            <div className="hosted-relay-steps" aria-label="Hosted Relay setup steps">
              <div>
                <Badge>1</Badge>
                <span>Relayで短命URLを発行</span>
              </div>
              <div>
                <Badge>2</Badge>
                <span>この端末のAgentを起動</span>
              </div>
              <div>
                <Badge>3</Badge>
                <span>AIへMCP URLを登録</span>
              </div>
            </div>
            <Input
              label="Agent WebSocket URL"
              value={hostedAgentWebsocketUrl}
              onChange={setHostedAgentWebsocketUrl}
              placeholder="wss://relay.example.com/agent/ws?pairing_code=..."
              type="password"
              autoComplete="off"
            />
            {hostedRelayMcpPreview ? (
              <div className="relay-preview">
                <Metric label={hostedRelayConfirmed ? "AIへ登録するMCP URL" : "pairing後に登録するMCP URL"} value={hostedRelayMcpPreview} />
                <button
                  className="secondary-button"
                  disabled={!hostedRelayConfirmed}
                  onClick={() => copyText(hostedRelayMcpPreview, "Hosted Relay MCP URLをコピーしました。")}
                  type="button"
                >
                  <Clipboard size={16} />
                  MCP URLをコピー
                </button>
              </div>
            ) : (
              <p className="muted">Hosted Relayで発行したAgent WebSocket URLを貼り付けます。</p>
            )}
            <div className="hosted-relay-boundary">
              <div>
                <span>この端末に保存</span>
                <strong>元文書・未承認の記憶候補・承認済みの事実</strong>
              </div>
              <div>
                <span>AIへ送信</span>
                <strong>確認画面で許可した短命Context Packのみ</strong>
              </div>
              <div>
                <span>Relayに残る</span>
                <strong>依頼ID・AI名・時刻・許可範囲だけ。本文は残さない</strong>
              </div>
            </div>
            <div className="service-actions">
              <button
                className="primary-button"
                disabled={!nativePath || aiServiceBusy || !hostedAgentWebsocketUrl.trim()}
                onClick={startHostedRelayAgent}
                type="button"
              >
                <Plug size={16} />
                Hosted RelayへAgent接続
              </button>
            </div>
            <details className="advanced-panel hosted-relay-advanced">
              <summary>self-host用pairingコマンド</summary>
              <pre className="code-box">{makeHostedPairingCurlTemplate()}</pre>
              <button
                className="secondary-button"
                onClick={() =>
                  copyText(makeHostedPairingCurlTemplate(), "Hosted Relay pairingコマンドをコピーしました。")
                }
                type="button"
              >
                <Clipboard size={16} />
                pairingコマンドをコピー
              </button>
            </details>
          </div>
          <div className="hosted-relay-status">
            <Metric label="現在のRelay" value={aiServiceStatus?.relayUrl ?? "未接続"} />
            <Metric label="接続方式" value={serviceManagedCopy(aiServiceStatus)} />
            <Metric
              label="この端末のアプリ"
              value={hostedAgentProcessCopy(aiServiceStatus)}
            />
            <Metric
              label="Relayとの確認"
              value={hostedPairingCopy(aiServiceStatus)}
            />
            <Metric
              label="最後の確認"
              value={formatUnixSeconds(aiServiceStatus?.agentRuntimeStatus?.updatedAt)}
            />
            <Metric
              label="問題"
              value={hostedLastErrorCopy(aiServiceStatus)}
            />
          </div>
        </div>
      </div>

      <div className="panel wide ai-access-map">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Universal AI Access</p>
            <h3>普段使うAIへ渡す入口と境界</h3>
          </div>
        </div>
        <div className="ai-access-map-grid">
          <div className="ai-access-endpoint">
            <span>MCP endpoint</span>
            <strong>{mcpEndpointDisplay}</strong>
            <p>ChatGPT/ClaudeのRemote MCP、Claude Desktop/CodexのLocal MCP、コピーfallbackのどれでも、AIへ渡す外部境界はContext Packだけです。</p>
            <div className="service-actions">
              <button
                className="primary-button"
                disabled={!canCopyMcpEndpoint}
                onClick={() => copyText(mcpEndpoint, "MCP URLをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                Copy URL
              </button>
              <button
                className="secondary-button"
                disabled={!currentConnectorInfo}
                onClick={() => {
                  if (!currentConnectorInfo) return;
                  copyText(JSON.stringify(currentConnectorInfo, null, 2), "Remote MCP connector情報をコピーしました。");
                }}
                type="button"
              >
                <Clipboard size={16} />
                Copy connector info
              </button>
              <button
                className="secondary-button"
                disabled={!canCopyMcpEndpoint}
                onClick={() => copyText(makeRemoteMcpSseCheckCommand(), "Remote MCP SSE診断コマンドをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                Copy SSE check
              </button>
            </div>
          </div>
          <div className="ai-access-boundary">
            <div>
              <span>AIへ渡るもの</span>
              <strong>確認済みContext Packだけ</strong>
              <p>Fact本文、最小Source snippet、除外理由、警告だけを目的別に絞ります。</p>
            </div>
            <div>
              <span>AIへ渡らないもの</span>
              <strong>Raw Source / 未承認候補 / Vault全体</strong>
              <p>保存と送信は別です。Inbox候補は承認されるまで高信頼文脈になりません。</p>
            </div>
          </div>
        </div>
        <div className="ai-access-checklist" aria-label="AI Access readiness checklist">
          {aiAccessChecklist.map((item) => (
            <div className={`ai-access-check ${item.state}`} key={item.label}>
              {item.state === "ready" ? <CheckCircle2 size={18} /> : item.state === "blocked" ? <ShieldAlert size={18} /> : <Clock size={18} />}
              <div>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <details className="panel wide setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">AI Connections</p>
            <h3>どのAIが、どの境界でVaultを使えるか</h3>
            <span>接続ごとの感度上限、確認条件、渡してよい生活領域を編集します。</span>
          </div>
          <Badge>詳細設定</Badge>
        </summary>
        <div className="connection-list">
          {connectors.map((connector) => {
            const policy = policies.find((item) => item.clientId === connector.id);
            const allowedDomains = domainsForPolicy(policy);
            const supportsContextPacks = connector.scopes.includes("context_pack.request");
            return (
              <article className="connection-card" key={connector.id}>
                <div className="connection-main">
                  <div className="connector-icon">
                    {connector.transport === "browser_extension" ? <Radio size={20} /> : <Plug size={20} />}
                  </div>
                  <div>
                    <h4>{connector.clientName}</h4>
                    <p>{connectionCopy(connector)}</p>
                  </div>
                </div>
                <div className="policy-grid">
                  <Metric label="Transport" value={connector.transport === "remote_mcp_relay" ? "Relay" : connector.transport === "local_mcp" ? "Local" : connector.transport === "browser_extension" ? "Capture" : "Copy"} />
                  <Metric label="Status" value={connector.status} />
                  <Metric label="Ceiling" value={policy?.sensitivityCeiling ?? "n/a"} />
                </div>
                <div className="scope-row">
                  {connector.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </div>
                <div className="policy-controls">
                  <label className="field">
                    <span>AIへ渡せる最大感度</span>
                    <select
                      value={policy?.sensitivityCeiling ?? "private_consequential"}
                      onChange={(event) =>
                        updatePolicy(connector.id, {
                          sensitivityCeiling: event.target.value as SensitivityTier
                        })
                      }
                    >
                      {policySensitivityOptions.map((sensitivity) => (
                        <option key={sensitivity} value={sensitivity}>
                          {sensitivityLabel(sensitivity)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>確認が必要になる感度</span>
                    <select
                      value={policy?.requiresApprovalAbove ?? "personal"}
                      onChange={(event) =>
                        updatePolicy(connector.id, {
                          requiresApprovalAbove: event.target.value as SensitivityTier
                        })
                      }
                    >
                      {policySensitivityOptions.map((sensitivity) => (
                        <option key={sensitivity} value={sensitivity}>
                          {sensitivityLabel(sensitivity)}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {supportsContextPacks ? (
                <div className="policy-domain-panel">
                  <div className="policy-domain-heading">
                    <div>
                      <strong>このAIに渡してよい生活領域</strong>
                      <span>
                        {allowedDomains.length}/{policyDomainOptions.length} 領域を許可中。未許可の領域はContext Packから除外されます。
                      </span>
                    </div>
                    <div className="policy-domain-actions">
                      <button
                        aria-label={`${connector.clientName}の生活領域をすべて許可する`}
                        className="secondary-button"
                        onClick={() => setPolicyDomains(connector.id, policyDomainOptions)}
                        type="button"
                      >
                        すべて許可
                      </button>
                      <button
                        aria-label={`${connector.clientName}の生活領域から本人情報、医療・ケア、お金・給付、制約・配慮を外す`}
                        className="secondary-button"
                        onClick={() => setPolicyDomains(connector.id, cautiousDomains)}
                        type="button"
                      >
                        個人情報等を外す
                      </button>
                    </div>
                  </div>
                  <div className="policy-domain-list">
                    {policyDomainOptions.map((domain) => {
                      const selected = allowedDomains.includes(domain);
                      return (
                        <label className="domain-checkbox" key={domain}>
                          <input
                            aria-label={`${connector.clientName}に${domainLabel(domain)}を渡す`}
                            checked={selected}
                            disabled={selected && allowedDomains.length === 1}
                            onChange={() => togglePolicyDomain(connector.id, policy, domain)}
                            type="checkbox"
                          />
                          <span>{domainLabel(domain)}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </details>

      <details className="panel wide setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">AI Access Service</p>
            <h3>普段使うAIへVaultを開く</h3>
            <span>Relay/Agentの状態、ログイン起動、常駐動作を管理します。</span>
          </div>
          <Badge>運用設定</Badge>
        </summary>
        <div className="service-console">
          <div className={`service-brief ${accessReadiness.tone}`}>
            <strong>{accessReadiness.title}</strong>
            <span>{accessReadiness.body}</span>
          </div>
          <div className="service-status-grid">
            <Metric label="Relay" value={aiServiceStatus?.relayReachable ? "reachable" : "offline"} />
            <Metric label="Agent" value={aiServiceStatus?.agentConnected ? "connected" : "offline"} />
            <Metric label="Managed" value={serviceManagedCopy(aiServiceStatus)} />
            <Metric label="MCP URL" value={mcpEndpointDisplay} />
          </div>
          <div className="service-actions">
            <button
              className="primary-button"
              disabled={!nativePath || aiServiceBusy}
              onClick={startAiAccess}
              type="button"
            >
              <PlayCircle size={16} />
              Start AI Access
            </button>
            <button
              className="secondary-button"
              disabled={!nativePath || aiServiceBusy}
              onClick={refreshAiAccess}
              type="button"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
            <button
              className="danger-button"
              disabled={!nativePath || aiServiceBusy || (!aiServiceStatus?.relayManagedRunning && !aiServiceStatus?.agentManagedRunning)}
              onClick={stopAiAccess}
              type="button"
            >
              <PauseCircle size={16} />
              Stop managed
            </button>
          </div>
          <div className="automation-grid">
            <div className="automation-card">
              <div className="automation-card-heading">
                <div>
                  <strong>ログイン時にアプリを起動</strong>
                  <p>再起動後もControl Centerが立ち上がり、AI Accessを戻せる状態にします。</p>
                </div>
                <Badge>
                  {loginItemStatus?.supported === false
                    ? "unsupported"
                    : loginItemStatus?.enabled
                      ? "enabled"
                      : "off"}
                </Badge>
              </div>
              <div className="service-actions">
                <button
                  className="primary-button"
                  disabled={!nativePath || loginItemBusy || loginItemStatus?.supported === false}
                  onClick={enableLoginItem}
                  type="button"
                >
                  <PlayCircle size={16} />
                  Enable login
                </button>
                <button
                  className="secondary-button"
                  disabled={!nativePath || loginItemBusy || !loginItemStatus?.enabled}
                  onClick={disableLoginItem}
                  type="button"
                >
                  <PauseCircle size={16} />
                  Disable
                </button>
                <button
                  className="secondary-button"
                  disabled={!nativePath || loginItemBusy}
                  onClick={refreshLoginItem}
                  type="button"
                >
                  <RefreshCw size={16} />
                  Check
                </button>
              </div>
              {loginItemStatus?.plistPath && <span>Startup item: {loginItemStatus.plistPath}</span>}
              {loginItemStatus?.backupPath && <span>Backup: {loginItemStatus.backupPath}</span>}
              {loginItemStatus?.lastError && <span>{loginItemStatus.lastError}</span>}
            </div>
            <div className="automation-card">
              <div className="automation-card-heading">
                <div>
                  <strong>起動時にAI Accessを自動開始</strong>
                  <p>アプリが開いたらRelayとAgentを起動します。Context Packの承認は引き続き手元で行います。</p>
                </div>
                <Badge>{runtimePreferences.autoStartAiAccess ? "on" : "off"}</Badge>
              </div>
              <button
                className={runtimePreferences.autoStartAiAccess ? "danger-button" : "primary-button"}
                onClick={() =>
                  updateRuntimePreference({
                    autoStartAiAccess: !runtimePreferences.autoStartAiAccess
                  })
                }
                type="button"
              >
                {runtimePreferences.autoStartAiAccess ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
                {runtimePreferences.autoStartAiAccess ? "Turn off" : "Turn on"}
              </button>
              <span>
                {runtimePreferences.autoStartAiAccess
                  ? "次回起動時にAI Accessを自動で戻します。"
                  : "必要なときだけ手動でStartします。"}
              </span>
            </div>
            <div className="automation-card">
              <div className="automation-card-heading">
                <div>
                  <strong>Control Centerの常駐</strong>
                  <p>
                    {nativePath
                      ? "ウィンドウを閉じてもVault管理面はmenu bar/trayに残り、AI Accessを止めません。"
                      : "Desktop appで開くと、Control Centerを閉じてもmenu bar/trayから戻せます。"}
                  </p>
                </div>
                <Badge>{nativePath ? "on" : "desktop"}</Badge>
              </div>
              <span>
                {nativePath
                  ? "完全に終了するときはmenu bar/trayのQuit Life Context Vaultを使います。"
                  : "ブラウザ表示では常駐動作とAI Access起動は使えません。"}
              </span>
            </div>
          </div>
          {aiServiceStatus?.lastError && <p className="warning-text">{aiServiceStatus.lastError}</p>}
          {!nativePath && <p className="muted">Desktop appで起動すると、ここからRelayとAgentを管理できます。</p>}
        </div>
      </details>

      <details className="panel wide setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">Local MCP setup</p>
            <h3>Claude Desktop / Codex系からVaultを呼び出す</h3>
            <span>Claude Desktop設定、手動config、公開tool一覧を確認します。</span>
          </div>
          <Badge>ローカルAI</Badge>
        </summary>
        <div className="service-brief">
          <strong>Claude Desktopへ追加</strong>
          <span>
            既存のClaude設定を保持し、life-context-vaultのMCP serverだけを追加します。既存ファイルがある場合はバックアップを作成します。
          </span>
          <div className="service-actions">
            <button
              className="primary-button"
              disabled={!nativePath || claudeInstallBusy}
              onClick={installClaudeConfig}
              type="button"
            >
              <Plug size={16} />
              Install Claude config
            </button>
            <button
              className="secondary-button"
              onClick={() => copyText(claudeConfig, "Claude Desktop用MCP設定をコピーしました。")}
              type="button"
            >
              <Clipboard size={16} />
              Copy config
            </button>
          </div>
          {claudeInstallResult && (
            <span>
              {claudeInstallResult.alreadyConfigured ? "設定済み" : "追加済み"}: {claudeInstallResult.configPath}
              {claudeInstallResult.backupPath ? ` / Backup: ${claudeInstallResult.backupPath}` : ""}
            </span>
          )}
          {!nativePath && <span>Desktop appで開くと、ここからClaude Desktop設定へ追加できます。</span>}
        </div>
        <div className="setup-grid">
          <div className="setup-step">
            <Badge>1</Badge>
            <strong>Local stdio MCP</strong>
            <div className="scope-row">
              <Badge>same device</Badge>
              <Badge>encrypted Vault</Badge>
              <Badge>Context Pack only</Badge>
            </div>
          </div>
          <div className="setup-step">
            <Badge>2</Badge>
            <strong>手動設定が必要な場合</strong>
            <pre className="code-box">{claudeConfig}</pre>
            <button
              className="secondary-button"
              onClick={() => copyText(claudeConfig, "Claude Desktop用MCP設定をコピーしました。")}
              type="button"
            >
              <Clipboard size={16} />
              Copy config
            </button>
          </div>
          <div className="setup-step">
            <Badge>3</Badge>
            <strong>公開されるtool</strong>
            <div className="scope-row">
              <Badge>request_context_pack</Badge>
              <Badge>propose_memory</Badge>
              <Badge>get_policy_summary</Badge>
              <Badge>get_request_status</Badge>
            </div>
          </div>
        </div>
        <p className="muted">Local MCPはVault全体を読ませません。重要な私的Context Packはアプリ側の確認待ちになり、未承認候補はFactとして使われません。</p>
      </details>

      <details className="panel wide setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">Advanced Remote Relay</p>
            <h3>Remote MCPの診断とself-host設定</h3>
            <span>Relay/Agentのコマンド、OAuth診断、保持しないデータ境界を確認します。</span>
          </div>
          <Badge>HTTP/MCP診断</Badge>
        </summary>
        <div className="trust-note">
          <ShieldCheck size={16} />
          <span>通常は上の接続ガイドだけで十分です。ここはHosted Relayの運用確認、ローカル検証、HTTP/MCP診断が必要なときに開きます。</span>
        </div>
        <details className="advanced-panel">
          <summary>コマンドとHTTP診断を表示</summary>
          <div className="setup-grid remote-relay-setup">
            <div className="setup-step">
              <Badge>1</Badge>
              <strong>RelayとAgentをビルド</strong>
              <pre className="code-box">npm run relay:build{"\n"}npm run agent:build</pre>
            </div>
            <div className="setup-step">
              <Badge>2</Badge>
              <strong>OAuth Relayを起動</strong>
              <pre className="code-box">{makeRelayCommand(nativePath)}</pre>
              <button
                className="secondary-button"
                onClick={() => copyText(makeRelayCommand(nativePath), "Relay起動コマンドをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                Copy command
              </button>
            </div>
            <div className="setup-step">
              <Badge>3</Badge>
              <strong>Pairing codeを発行</strong>
              <pre className="code-box">{makePairingCommand()}</pre>
              <button
                className="secondary-button"
                onClick={() => copyText(makePairingCommand(), "Agent pairingコマンドをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                Copy pairing
              </button>
            </div>
            <div className="setup-step">
              <Badge>4</Badge>
              <strong>Local Agentを接続</strong>
              <pre className="code-box">{makeAgentCommand(nativePath)}</pre>
              <button
                className="secondary-button"
                onClick={() => copyText(makeAgentCommand(nativePath), "Local Agent起動コマンドをコピーしました。")}
                type="button"
              >
                <Clipboard size={16} />
                Copy agent
              </button>
            </div>
            <div className="setup-step">
              <Badge>OAuth</Badge>
              <strong>ChatGPT / Claude connectorへ渡すURL</strong>
              <pre className="code-box">{JSON.stringify(makeRemoteConnectorInfo(localRelayUrl), null, 2)}</pre>
            </div>
            <div className="setup-step">
              <Badge>Check</Badge>
              <strong>接続前のHTTP診断</strong>
              <div className="scope-row">
                <Badge>health: 200</Badge>
                <Badge>mcp: 401 OAuth</Badge>
                <Badge>sse: ready</Badge>
                <Badge>headers: 406/415</Badge>
              </div>
              <pre className="code-box">{makeRelayHealthCheckCommand()}</pre>
              <div className="service-actions">
                <button
                  className="secondary-button"
                  onClick={() => copyText(makeRelayHealthCheckCommand(), "Relay health checkをコピーしました。")}
                  type="button"
                >
                  <Clipboard size={16} />
                  Copy health
                </button>
                <button
                  className="secondary-button"
                  onClick={() => copyText(makeRemoteMcpHeaderCheckCommand(), "Remote MCP診断コマンドをコピーしました。")}
                  type="button"
                >
                  <Clipboard size={16} />
                  Copy MCP check
                </button>
                <button
                  className="secondary-button"
                  onClick={() => copyText(makeRemoteMcpSseCheckCommand(), "Remote MCP SSE診断コマンドをコピーしました。")}
                  type="button"
                >
                  <Clipboard size={16} />
                  Copy SSE check
                </button>
              </div>
              <pre className="code-box">{makeRemoteMcpHeaderCheckCommand()}</pre>
              <pre className="code-box">{makeRemoteMcpSseCheckCommand()}</pre>
            </div>
            <div className="setup-step">
              <Badge>Boundary</Badge>
              <strong>Relayが保持しないもの</strong>
              <div className="scope-row">
                <Badge>Raw Vault</Badge>
                <Badge>Raw Source</Badge>
                <Badge>MCP body</Badge>
                <Badge>Pack body</Badge>
                <Badge>long-lived Pack</Badge>
              </div>
            </div>
            <div className="setup-step">
              <Badge>State</Badge>
              <strong>Relayが監査用に保持するもの</strong>
              <div className="scope-row">
                <Badge>OAuth clients</Badge>
                <Badge>request metadata</Badge>
                <Badge>scope decision</Badge>
              </div>
              <pre className="code-box">{`${localRelayBaseUrl}/relay/state`}</pre>
            </div>
          </div>
        </details>
        <p className="muted">Remote MCP RelayはOAuth/PKCEでAIクライアントを認可し、pairing済みLocal AgentへWebSocketで要求を渡します。RelayはOAuth client登録とリクエストの監査メタデータだけを永続化し、Vault本文・MCP本文・Context Pack本文は置きません。</p>
      </details>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Passive Capture</p>
            <h3>AI会話から候補を作る</h3>
          </div>
          {captureSettings.enabled ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
        </div>
        <div className="toggle-row">
          <span>{captureSettings.enabled ? "Capture中" : "停止中"}</span>
          <button
            className={captureSettings.enabled ? "danger-button" : "primary-button"}
            onClick={() => updateCapture({ enabled: !captureSettings.enabled })}
            type="button"
          >
            {captureSettings.enabled ? <PauseCircle size={16} /> : <PlayCircle size={16} />}
            {captureSettings.enabled ? "Pause" : "Start"}
          </button>
        </div>
        <div className="form-stack">
          <Input
            label="保持日数"
            value={String(captureSettings.retentionDays)}
            onChange={(value) => updateCapture({ retentionDays: Number(value) || 14 })}
            type="number"
          />
          <label className="field">
            <span>Captureを許可するAIサイト</span>
            <input
              value={allowedSitesDraft}
              onChange={(event) => setAllowedSitesDraft(event.target.value)}
              placeholder="chatgpt.com, claude.ai, gemini.google.com"
            />
          </label>
          <div className="service-actions">
            <button
              className="secondary-button"
              onClick={() =>
                updateCapture({
                  allowedSites: parseAllowedSitesInput(allowedSitesDraft)
                })
              }
              type="button"
            >
              <ShieldCheck size={16} />
              許可サイトを保存
            </button>
          </div>
          <p className="muted">Raw transcriptは初期設定で{captureSettings.retentionDays}日後に消えます。候補が承認されるまでFactにはなりません。</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Recent Captures</p>
            <h3>直近で取り込んだ会話断片</h3>
          </div>
          <Badge>{purgeableCaptureCount} active</Badge>
        </div>
        <div className="capture-status-strip">
          <div>
            <strong>{captureSettings.enabled ? "Captureは有効" : "Captureは停止中"}</strong>
            <span>
              {captureSettings.enabled
                ? `${captureSettings.allowedSites.join(", ")} の会話断片だけをローカルで候補化します。`
                : "停止中はブラウザ拡張や手動Captureから書き込みません。"}
            </span>
          </div>
          <button
            className="danger-button"
            disabled={purgeableCaptureCount === 0}
            onClick={purgeAllPassiveCaptures}
            type="button"
          >
            <Trash2 size={16} />
            全本文を消去
          </button>
        </div>
        <div className="capture-history-list">
          {recentCaptures.map((event) => {
            const sourceId = passiveCaptureSourceId(event);
            const source = sourceId ? sources.find((item) => item.id === sourceId) : undefined;
            const sourcePurged = source?.deletionState === "purged" || event.processingStatus === "purged";
            return (
              <div className="capture-history-row" key={event.id}>
                <div>
                  <div className="capture-history-heading">
                    <strong>{connectorKindLabel(event.sourceClient)}</strong>
                    <span>{formatDateTime(event.capturedAt)}</span>
                  </div>
                  <p>{capturePreviewText(source)}</p>
                  <div className="scope-row">
                    <Badge>{captureEventStatusLabel(event, source)}</Badge>
                    <SensitivityBadge sensitivity={event.sensitivityGuess} />
                    <Badge>{event.candidateIds.length}候補</Badge>
                    <Badge>{event.urlHash}</Badge>
                  </div>
                  <span>保持期限: {formatDateTime(event.retentionUntil)}</span>
                </div>
                <button
                  className="danger-button"
                  disabled={!sourceId || sourcePurged}
                  onClick={() => purgePassiveCaptureEvent(event.id)}
                  type="button"
                >
                  <Trash2 size={16} />
                  本文消去
                </button>
              </div>
            );
          })}
          {recentCaptures.length === 0 && <p className="muted">まだCapture履歴はありません。</p>}
        </div>
      </div>

      <details className="panel setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">Browser extension</p>
            <h3>AIチャット画面から直接Inboxへ送る</h3>
            <span>Chrome Native Messaging hostと拡張IDを設定します。</span>
          </div>
          <Badge>拡張設定</Badge>
        </summary>
        <div className="form-stack">
          <div className="service-brief">
            <strong>Chrome Native Hostを追加</strong>
            <span>
              Chromeで`browser-extension/`をLoad unpackedし、表示された拡張IDを貼ると、この端末のNative Messaging hostを設定します。
            </span>
            <Input
              label="Chrome拡張ID"
              value={captureExtensionId}
              onChange={setCaptureExtensionId}
              placeholder="例: abcdefghijklmnopabcdefghijklmnop"
            />
            <div className="service-actions">
              <button
                className="primary-button"
                disabled={!nativePath || !captureExtensionIdReady || captureHostInstallBusy}
                onClick={installCaptureHostManifest}
                type="button"
              >
                <Plug size={16} />
                Install host
              </button>
              <button
                className="secondary-button"
                onClick={() =>
                  copyText(
                    makeCaptureSetupCommand(captureExtensionId),
                    "ブラウザ拡張セットアップコマンドをコピーしました。"
                  )
                }
                type="button"
              >
                <Clipboard size={16} />
                Copy fallback
              </button>
            </div>
            {captureHostInstallResult && (
              <span>
                {captureHostInstallResult.alreadyConfigured ? "設定済み" : "追加済み"}: {captureHostInstallResult.manifestPath}
                {captureHostInstallResult.backupPath ? ` / Backup: ${captureHostInstallResult.backupPath}` : ""}
              </span>
            )}
            {!nativePath && <span>Desktop appで開くと、ここからChrome Native Hostを追加できます。</span>}
            {captureExtensionId && !captureExtensionIdReady && (
              <span>拡張IDはChrome拡張機能画面に表示される32文字のIDです。</span>
            )}
          </div>
          <pre className="code-box">{makeCaptureSetupCommand(captureExtensionId)}</pre>
          <p className="muted">Captureはpopup操作で明示的に実行され、Passive CaptureがStartで、対象サイトが許可済みのときだけInbox候補を作ります。</p>
          <button
            className="secondary-button"
            onClick={() =>
              copyText(
                makeCaptureSetupCommand(captureExtensionId),
                "ブラウザ拡張セットアップコマンドをコピーしました。"
              )
            }
            type="button"
          >
            <Clipboard size={16} />
            Copy setup
          </button>
        </div>
      </details>

      <details className="panel setup-disclosure">
        <summary className="panel-summary">
          <div>
            <p className="eyebrow">Manual capture</p>
            <h3>拡張が使えない時の入力</h3>
            <span>会話断片を手動でInbox候補にします。自動Fact化はしません。</span>
          </div>
          <Badge>手動入力</Badge>
        </summary>
        <div className="form-stack">
          <label className="field">
            <span>AIクライアント</span>
            <select value={captureClient} onChange={(event) => setCaptureClient(event.target.value as ConnectorKind)}>
              <option value="chatgpt">ChatGPT</option>
              <option value="claude_remote">Claude</option>
              <option value="gemini">Gemini</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <Input label="会話ID" value={captureConversationId} onChange={setCaptureConversationId} />
          <Textarea label="会話断片" value={captureText} onChange={setCaptureText} placeholder="例: 来月引っ越す予定。住所変更が必要な契約を後で確認したい。" />
          <button className="primary-button" onClick={simulatePassiveCapture} type="button">
            <Radio size={16} />
            Capture候補を作成
          </button>
        </div>
      </details>
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
  changePackItemVisibility
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
}) {
  const aiReady =
    currentPack?.confirmationStatus === "confirmed" ||
    currentRequest?.status === "fulfilled";
  const requestClosed =
    currentRequest?.status === "denied" ||
    currentRequest?.status === "expired" ||
    currentPack?.confirmationStatus === "cancelled";
  const hiddenExcludedFacts = currentPack
    ? currentPack.excludedItems
        .filter((item) => item.reason === "user_hidden")
        .map((item) => ({
          exclusion: item,
          fact: facts.find((fact) => fact.id === item.referencedId)
        }))
    : [];
  const pendingReviewRequests = requests.filter((request) => request.status === "pending_user_confirmation");
  const unreturnedLowRiskRequests = requests.filter((request) => request.status === "approved");
  const actionableRequests = requests.filter((request) => requestNeedsUserAction(request));
  const readyRequests = requests.filter((request) => request.status === "fulfilled");
  const closedRequests = requests.filter((request) => request.status === "denied" || request.status === "expired");
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
        : "新しいAI要求が届くとここに並びます。手動テストは下の折りたたみから試せます。";
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
              className={`request-row ${requestStatusTone(request.status)}${currentRequest?.id === request.id ? " active" : ""}`}
              key={request.id}
              onClick={() => setActiveRequest(request)}
              type="button"
            >
              <span>{request.clientName}</span>
              <strong>{requestStatusLabel(request.status)}</strong>
              <small>{request.taskText}</small>
              <small>{formatDateTime(request.createdAt)} / {formatDateTime(request.expiresAt)}まで</small>
            </button>
          ))}
          {requests.length === 0 && (
            <EmptyState
              title="まだAI要求はありません"
              body="ChatGPT/Claudeなどから要求が届くと、AIへ返す前にこのInboxで確認できます。"
            />
          )}
        </div>
        <details className="advanced-panel request-test-panel">
          <summary>手動でContext Packを試す</summary>
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
              テスト要求を作成
            </button>
            <p className="muted">手動テストでも、AIへ返す前に同じContext Pack確認とAuditを通します。</p>
          </div>
        </details>
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
                この内容だけAIへ許可
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
            <Metric label="状態" value={requestStatusLabel(currentRequest.status)} />
          </div>
        )}
        {!currentPack ? (
          <p className="muted">AI要求を選ぶと、送信予定の背景情報と根拠がここに表示されます。</p>
        ) : (
          <div className="context-pack">
            <div className={aiReady ? "pack-delivery ready" : "pack-delivery attention"}>
              {aiReady ? <CheckCircle2 size={18} /> : <Clock size={18} />}
              <div>
                <strong>{aiReady ? "AIへ返せる状態です" : "AIへ返す前に確認が必要です"}</strong>
                <span>
                  {aiReady
                    ? "外部AIはget_request_statusで、このContext Packだけを取得できます。"
                    : "承認するまで、外部AIにはPack本文を返しません。"}
                </span>
              </div>
            </div>
            <div className="pack-scope-summary">
              <ShieldCheck size={16} />
              <span>
                {currentPack.items.length}件のFactと{currentPack.sourceSnippets?.length ?? 0}件の根拠snippetだけを送信予定。除外は{currentPack.excludedItems.length}件です。
              </span>
            </div>
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
          <Badge>{inventory.active} AI候補</Badge>
        </div>
        <div className="context-inventory-grid">
          <Metric label="AI候補" value={inventory.active} />
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
        <Badge>{results.length} results</Badge>
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
              <h3>AI候補から外れているFact</h3>
            </div>
            <Badge>{filteredExcludedFacts.length}件</Badge>
          </div>
          <div className="trust-note">
            <EyeOff size={16} />
            <span>非表示、削除済みのFactです。AIに使う必要が戻ったものだけ、明示的にAI候補へ戻します。</span>
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
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Backup</p>
            <h3>暗号化バックアップ</h3>
          </div>
          <Lock size={18} />
        </div>
        <div className="form-stack">
          <Input label="パスフレーズ" value={passphrase} onChange={setPassphrase} placeholder="復元にも同じ値が必要です" type="password" />
          <button className="primary-button" onClick={exportBackup} type="button">
            <Download size={16} />
            Export
          </button>
          <Textarea label="Backup JSON" value={backupText} onChange={setBackupText} placeholder="復元する場合はここに貼り付け" />
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
                <Metric label="Sources" value={restorePreview.counts.sources} />
                <Metric label="Facts" value={restorePreview.counts.facts} />
                <Metric label="Inbox候補" value={restorePreview.counts.candidates} />
                <Metric label="Context Packs" value={restorePreview.counts.packs} />
                <Metric label="Requests" value={restorePreview.counts.requests} />
                <Metric label="Captures" value={restorePreview.counts.captureEvents} />
              </div>
              <div className="trust-note attention-note">
                <ShieldAlert size={16} />
                <span>
                  復元すると現在のVault全体をこのバックアップで置き換えます。内容の感度は{restorePreview.sensitivitySummary}です。
                  {restorePreview.newestSourceAt ? ` 最新Source: ${formatDateTime(restorePreview.newestSourceAt)}。` : ""}
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
            <p className="muted">復元前にBackup JSONを復号し、件数と感度を確認します。確認前に現在のVaultは変更されません。</p>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Legacy Office conversion</p>
            <h3>DOC / XLS / PPTを変換して読む</h3>
          </div>
          <Badge>{hasLegacyOfficeCommand ? "configured" : "off"}</Badge>
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
              <span>LibreOfficeはまだ見つかっていません。インストール後にこの画面を開き直すか、下のCommandへローカル変換コマンドを直接入力してください。</span>
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
                    Copy
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
            label="Command"
            value={runtimePreferences.legacyOfficeCommand}
            onChange={(value) => updateRuntimePreference({ legacyOfficeCommand: value })}
            placeholder="/Applications/LibreOffice.app/Contents/MacOS/soffice"
          />
          <Textarea
            label="Arguments"
            value={runtimePreferences.legacyOfficeArgs}
            onChange={(value) => updateRuntimePreference({ legacyOfficeArgs: value })}
            placeholder="--headless --convert-to {target_ext} --outdir {output_dir} {input}"
          />
          <Input
            label="Timeout seconds"
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
              Clear
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Storage</p>
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
            <Badge>{storageReady ? "ready" : "loading"}</Badge>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Local OCR</p>
            <h3>画像本文の抽出</h3>
          </div>
          <Badge>{hasOcrCommand ? "configured" : "off"}</Badge>
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
              <span>Tesseract OCRはまだ見つかっていません。インストール後にこの画面を開き直すか、下のCommandへローカルOCRコマンドを直接入力してください。</span>
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
                    Copy
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
            label="Command"
            value={runtimePreferences.ocrCommand}
            onChange={(value) => updateRuntimePreference({ ocrCommand: value })}
            placeholder="/opt/homebrew/bin/tesseract"
          />
          <Textarea
            label="Arguments"
            value={runtimePreferences.ocrArgs}
            onChange={(value) => updateRuntimePreference({ ocrArgs: value })}
            placeholder="{input} stdout -l eng+jpn"
          />
          <Input
            label="Timeout seconds"
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
              Clear
            </button>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Demo</p>
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
              <span>Vaultをクリアすると、Sources、候補、Fact、Context Pack、接続監査が空になります。バックアップが必要なら先にExportしてください。</span>
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

function auditReceiptBody(event: AuditEvent): string {
  const itemCount = metadataNumber(event, "itemCount");
  const snippetCount = metadataNumber(event, "sourceSnippetCount");
  const excludedCount = metadataNumber(event, "excludedCount");
  const ttl = metadataNumber(event, "ttlSeconds");
  const pieces = [
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
            AI候補へ戻す
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

function requestNeedsUserAction(request: ContextPackRequest): boolean {
  return request.status === "pending_user_confirmation" || request.status === "approved";
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

function makeRestorePreview(restored: VaultState): RestorePreview {
  const newestSourceAt = restored.sources
    .map((source) => source.createdAt)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const highestSensitivity = maxVaultSensitivity(restored);
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      sources: restored.sources.length,
      candidates: restored.candidates.length,
      facts: restored.facts.length,
      requests: restored.contextPackRequests.length,
      packs: restored.contextPacks.length,
      captureEvents: restored.passiveCaptureEvents.length
    },
    sensitivitySummary: highestSensitivity ? sensitivityLabel(highestSensitivity) : "空のVault",
    newestSourceAt
  };
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
    return `FactをAI候補から非表示にしました。${invalidatedPackCount}件のContext Packを無効化しました。`;
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

function serviceManagedCopy(status: AiAccessServiceStatus | null): string {
  if (!status) return "Desktopのみ";
  if (status.relayMode === "hosted_agent") return status.agentConnected ? "Hosted接続済み" : status.agentManagedRunning ? "Hosted確認中" : "Hosted停止中";
  if (status.relayManagedRunning && status.agentManagedRunning) return "ローカルRelay + Agent";
  if (status.relayManagedRunning) return "ローカルRelay";
  if (status.agentManagedRunning) return "ローカルAgent";
  if (status.relayReachable || status.agentConnected) return "外部Relay";
  return "停止中";
}

function hostedAgentProcessCopy(status: AiAccessServiceStatus | null): string {
  if (status?.relayMode !== "hosted_agent") return "未使用";
  return status.agentManagedRunning ? "起動中" : "停止中";
}

function hostedPairingCopy(status: AiAccessServiceStatus | null): string {
  if (status?.relayMode !== "hosted_agent") return "未接続";
  if (status.agentConnected) return "確認済み";
  const state = status.agentRuntimeStatus?.state;
  if (state === "connecting") return "確認中";
  if (state === "disconnected") return "再pairingが必要";
  return status.agentManagedRunning ? "待機中" : "停止中";
}

function hostedLastErrorCopy(status: AiAccessServiceStatus | null): string {
  if (status?.relayMode !== "hosted_agent") return "なし";
  return status.agentRuntimeStatus?.lastError ?? "なし";
}

function aiAccessReadinessCopy(
  status: AiAccessServiceStatus | null,
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
      title: "Desktop appでAI Accessを管理できます",
      body: "ブラウザ表示ではVault Agentを起動できません。",
      detail:
        "Vault本体とAgentはローカルで動く前提です。Desktop appを開くと、RelayとAgentをここから起動できます。",
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
    return {
      badge: "Pairing check",
      title: "Hosted Relayへのpairingを待っています",
      body: "この端末のアプリは起動中です。Relay側の確認が取れるまでReady扱いにしません。",
      detail:
        status.agentRuntimeStatus?.lastError
          ? `直近の接続エラー: ${status.agentRuntimeStatus.lastError}`
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
        "手動で起動したRelayを使う場合は手動pairingを続けてください。アプリ管理にしたい場合は外部Relayを停止してからStart AI Accessを押します。",
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
    title: "AI Access Serviceはまだ停止しています",
    body: "Start AI AccessでRelayとLocal Agentをまとめて起動します。閉じた後はmenu bar/trayから戻せます。",
    detail:
      "最初は背景情報を承認してから起動すると、AIに渡すContext Packの確認まで一気に試せます。",
    tone: "neutral"
  };
}

function aiAccessChecklistItems(
  status: AiAccessServiceStatus | null,
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
        ? "Remote MCPのHTTPS/HTTP入口が応答しています。"
        : "Start AI AccessでMCP endpointを起動します。",
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
        ? "POST JSON-RPC、GET SSE、MCP session、DELETE終了に対応しています。"
        : "Relay起動後にSSE ready診断で確認できます。",
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
  status: Pick<AiAccessServiceStatus, "agentConnected" | "relayMode"> | null
): boolean {
  return status?.relayMode === "hosted_agent" && Boolean(status.agentConnected);
}

export function canCopyAiMcpEndpoint(
  status: Pick<AiAccessServiceStatus, "agentConnected" | "relayMode"> | null
): boolean {
  return status?.relayMode !== "hosted_agent" || Boolean(status.agentConnected);
}

export function aiMcpEndpointDisplay(
  status: Pick<AiAccessServiceStatus, "agentConnected" | "relayMode"> | null,
  endpoint: string
): string {
  return canCopyAiMcpEndpoint(status) ? endpoint : "pairing確認後に表示";
}

export function webAiMcpEndpoint(
  status: Pick<AiAccessServiceStatus, "agentConnected" | "relayMode"> | null,
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
    dynamicClientRegistration: `${baseUrl}/oauth/register`,
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
