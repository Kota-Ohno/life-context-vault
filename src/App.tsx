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
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AiAccessServiceStatus,
  BrowserCaptureHostInstallResult,
  ClaudeDesktopConfigInstallResult,
  LoginItemStatus,
  addNativeSourceWithCandidates,
  approveNativeCandidate,
  createNativeContextPackRequest,
  getAiAccessServiceStatus,
  getClaudeDesktopConfigTemplate,
  getLoginItemStatus,
  getNativeVaultPath,
  installChromeCaptureHostManifest,
  installClaudeDesktopConfig,
  installLoginItem,
  loadNativeVaultSnapshot,
  saveNativeVault,
  searchNativeFacts,
  startAiAccessServices,
  stopAiAccessServices,
  updateNativeCandidateStatus,
  uninstallLoginItem
} from "./nativeStorage";
import {
  RuntimePreferences,
  loadRuntimePreferences,
  saveRuntimePreferences
} from "./runtimePreferences";
import {
  addSourceWithCandidates,
  addPassiveCaptureEvent,
  approveCandidate,
  attachLocalAnswer,
  backgroundSetupBody,
  buildContextPackForRequest,
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
  saveContextPack,
  saveVault,
  searchFacts,
  sensitivityLabel,
  updatePassiveCaptureSettings,
  updateCandidateStatus
} from "./vault";
import {
  ApprovedFact,
  BackgroundSetupInput,
  CandidateStatus,
  ConnectorKind,
  ConnectorSession,
  ContextPack,
  ContextPackRequest,
  LifeContextDomain,
  MemoryCandidate,
  PassiveCaptureSettings,
  SensitivityTier,
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

const sensitivityOptions: Array<SensitivityTier | "all"> = [
  "all",
  "public",
  "personal",
  "private_consequential",
  "sensitive",
  "secret_never_send"
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
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
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
  const [notice, setNotice] = useState("");
  const [aiServiceStatus, setAiServiceStatus] = useState<AiAccessServiceStatus | null>(null);
  const [aiServiceBusy, setAiServiceBusy] = useState(false);
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
        const [nativeSnapshot, path, configTemplate] = await Promise.all([
          loadNativeVaultSnapshot(),
          getNativeVaultPath(),
          getClaudeDesktopConfigTemplate()
        ]);
        if (cancelled) return;
        if (nativeSnapshot?.state) setState(nativeSnapshot.state);
        nativeRevisionRef.current = nativeSnapshot?.updatedAt ?? null;
        setNativeRevision(nativeSnapshot?.updatedAt ?? null);
        setNativePath(path);
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
          const pendingRequest = mergedState.contextPackRequests.find(
            (request) => request.status === "pending_user_confirmation"
          );
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

        const pendingRequest = snapshot.state.contextPackRequests.find(
          (request) => request.status === "pending_user_confirmation"
        );
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
    const text = await file.text();
    const addStatus = await addSourceThroughCore(
      {
        kind: "document",
        origin: "user_upload",
        title: file.name,
        body: text
      },
      `${file.name} をSourceとして保存し、Memory Inboxに候補を追加しました。`
    );
    if (addStatus === "unavailable") {
      const next = addSourceWithCandidates(state, {
        kind: "document",
        origin: "user_upload",
        title: file.name,
        body: text
      });
      apply(next, `${file.name} をSourceとして保存し、Memory Inboxに候補を追加しました。`);
      setView("inbox");
    }
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

  async function approve(candidate: MemoryCandidate) {
    const edited = candidateEdits[candidate.id];
    if (nativePath) {
      try {
        const reviewed = await approveNativeCandidate({
          candidateId: candidate.id,
          editedText: edited
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
          setNotice("承認済みFactとして保存しました。AIへ渡るのはContext Pack確認後だけです。");
          return;
        }
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Vault Coreで候補を承認できませんでした。");
        return;
      }
    }
    const next = approveCandidate(state, candidate.id, edited);
    apply(next, "承認済みFactとして保存しました。");
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

  function approvePackForAi(pack: ContextPack) {
    const request = pack.requestId
      ? state.contextPackRequests.find((item) => item.id === pack.requestId)
      : null;
    if (pack.confirmationStatus === "confirmed" && request?.status === "fulfilled") {
      setNotice("このContext PackはすでにAIへ返せる状態です。");
      return;
    }
    apply(
      confirmContextPack(state, pack.id),
      "Context Packを承認しました。外部AIはget_request_statusで取得できます。"
    );
  }

  async function copyPackForAi(pack: ContextPack) {
    const request = pack.requestId
      ? state.contextPackRequests.find((item) => item.id === pack.requestId)
      : null;
    const shouldConfirm = pack.confirmationStatus !== "confirmed" || request?.status !== "fulfilled";
    const payloadPack = shouldConfirm
      ? { ...pack, confirmationStatus: "confirmed" as const, confirmedAt: new Date().toISOString() }
      : pack;
    if (shouldConfirm) {
      setState(confirmContextPack(state, pack.id));
    }
    await copyText(
      JSON.stringify(makeAiContextPackPayload(payloadPack), null, 2),
      shouldConfirm
        ? "Context Packを承認し、AI向けペイロードをコピーしました。"
        : "AI向けContext Packをコピーしました。"
    );
  }

  function denyActiveRequest() {
    if (!activeRequestId) return;
    apply(denyContextPackRequest(state, activeRequestId), "このContext Requestを拒否しました。");
  }

  function updateCapture(settings: Partial<PassiveCaptureSettings>) {
    apply(updatePassiveCaptureSettings(state, settings), "Capture設定を更新しました。");
  }

  function simulatePassiveCapture() {
    if (!captureText.trim()) {
      setNotice("Captureする会話断片を入力してください。");
      return;
    }
    const next = addPassiveCaptureEvent(state, {
      sourceClient: captureClient,
      conversationId: captureConversationId || "demo-thread",
      url: `https://${captureClient}.example/${captureConversationId || "demo-thread"}`,
      text: captureText
    });
    apply(next, state.passiveCaptureSettings.enabled ? "CaptureからMemory候補を生成しました。" : "Captureは停止中です。");
    if (state.passiveCaptureSettings.enabled) {
      setCaptureText("");
      setView("inbox");
    }
  }

  async function copyText(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setNotice("Clipboardに書き込めませんでした。表示された内容を手動でコピーしてください。");
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

  async function restoreBackup() {
    try {
      const restored = await importEncryptedBackup(backupText, backupPassphrase);
      apply(restored, "バックアップを復元しました。");
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
    apply(createEmptyVault(), "Vaultをクリアしました。");
    setActivePackId(null);
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
            <p>Local PoC</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Primary">
          <NavButton icon={<Home size={18} />} label="Home" active={view === "home"} onClick={() => setView("home")} />
          <NavButton icon={<Inbox size={18} />} label="Inbox" active={view === "inbox"} onClick={() => setView("inbox")} badge={activeCandidates.length} />
          <NavButton icon={<FileText size={18} />} label="Sources" active={view === "sources"} onClick={() => setView("sources")} />
          <NavButton icon={<Plug size={18} />} label="Connections" active={view === "connections"} onClick={() => setView("connections")} />
          <NavButton icon={<MessageSquare size={18} />} label="Requests" active={view === "requests"} onClick={() => setView("requests")} badge={state.contextPackRequests.filter((request) => request.status === "pending_user_confirmation").length} />
          <NavButton icon={<Search size={18} />} label="Search" active={view === "search"} onClick={() => setView("search")} />
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
            edits={candidateEdits}
            setEdit={(id, value) => setCandidateEdits((prev) => ({ ...prev, [id]: value }))}
            approve={approve}
            reject={(candidate) => void reviewCandidateStatus(candidate, "rejected", "候補を却下しました。")}
            archive={(candidate) => void reviewCandidateStatus(candidate, "archived", "候補をLaterに移しました。")}
            markSensitive={(candidate) =>
              void reviewCandidateStatus(candidate, "blocked_sensitive", "候補をセンシティブ扱いにしました。")
            }
          />
        )}
        {view === "sources" && (
          <SourcesView
            sources={state.sources}
            manualTitle={manualTitle}
            manualBody={manualBody}
            setManualTitle={setManualTitle}
            setManualBody={setManualBody}
            addManualSource={addManualSource}
            handleFileUpload={handleFileUpload}
          />
        )}
        {view === "connections" && (
          <ConnectionsView
            connectors={state.connectorSessions}
            policies={state.accessPolicies}
            captureSettings={state.passiveCaptureSettings}
            approvedFactCount={activeFacts.length}
            pendingCandidateCount={activeCandidates.length}
            requestCount={state.contextPackRequests.length}
            updateCapture={updateCapture}
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
            stopAiAccess={stopAiAccess}
            refreshAiAccess={refreshAiAccess}
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
            approvePackForAi={approvePackForAi}
            copyPackForAi={copyPackForAi}
            generateAnswer={generateAnswer}
            denyActiveRequest={denyActiveRequest}
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
            results={searchResults}
            searchMode={searchMode}
            searchError={searchError}
            nativePath={nativePath}
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
            restoreBackup={restoreBackup}
            clearVault={clearVault}
            seedDemo={seedDemo}
            nativePath={nativePath}
            nativeRevision={nativeRevision}
            storageReady={storageReady}
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
    <button className={active ? "nav-item active" : "nav-item"} onClick={onClick} type="button">
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
                  <FactRow fact={fact} key={fact.id} />
                ))}
              </section>
            ))}
          </div>
        )}
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

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Guided setup</p>
            <h3>背景情報を追加</h3>
          </div>
        </div>
        <SetupForm setup={setup} setSetup={setSetup} submitBackground={submitBackground} />
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
  submitBackground
}: {
  setup: BackgroundSetupInput;
  setSetup: (input: BackgroundSetupInput) => void;
  submitBackground: () => void;
}) {
  return (
    <div className="form-stack">
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

function InboxView({
  candidates,
  edits,
  setEdit,
  approve,
  reject,
  archive,
  markSensitive
}: {
  candidates: MemoryCandidate[];
  edits: Record<string, string>;
  setEdit: (id: string, value: string) => void;
  approve: (candidate: MemoryCandidate) => void;
  reject: (candidate: MemoryCandidate) => void;
  archive: (candidate: MemoryCandidate) => void;
  markSensitive: (candidate: MemoryCandidate) => void;
}) {
  if (candidates.length === 0) {
    return (
      <EmptyState
        title="Inboxは空です"
        body="背景セットアップ、会話メモ、文書アップロードから候補が生成されます。"
      />
    );
  }

  return (
    <section className="candidate-list">
      {candidates.map((candidate) => (
        <article className="candidate-card" key={candidate.id}>
          <div className="candidate-meta">
            <Badge>{domainLabel(candidate.domain)}</Badge>
            <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
            <Badge>{candidate.confidence}</Badge>
          </div>
          <textarea
            aria-label="Candidate text"
            value={edits[candidate.id] ?? candidate.proposedFactText}
            onChange={(event) => setEdit(candidate.id, event.target.value)}
          />
          <p>{candidate.reasonToRemember}</p>
          {candidate.status === "blocked_sensitive" && (
            <div className="warning-line">
              <ShieldAlert size={16} />
              センシティブ候補です。保存すると、この情報はContext Pack使用時にも確認対象になります。
            </div>
          )}
          <div className="action-row">
            <button className="primary-button" onClick={() => approve(candidate)} type="button">
              <Check size={16} />
              保存
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
      ))}
    </section>
  );
}

function SourcesView({
  sources,
  manualTitle,
  manualBody,
  setManualTitle,
  setManualBody,
  addManualSource,
  handleFileUpload
}: {
  sources: VaultState["sources"];
  manualTitle: string;
  manualBody: string;
  setManualTitle: (value: string) => void;
  setManualBody: (value: string) => void;
  addManualSource: () => void;
  handleFileUpload: (file: File) => void;
}) {
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
            <h3>テキスト文書を追加</h3>
          </div>
        </div>
        <label className="drop-zone">
          <Upload size={24} />
          <span>TXT/MD/CSV/JSONなどテキストとして読めるファイル</span>
          <input
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFileUpload(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <p className="muted">アップロード直後は候補化だけを行います。PDF/OCRはTauri版以降の抽出パイプラインに分離予定です。</p>
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Source history</p>
            <h3>追加済みSource</h3>
          </div>
        </div>
        <div className="table-list">
          {sources.map((source) => (
            <div className="table-row" key={source.id}>
              <div>
                <strong>{source.title}</strong>
                <span>{source.kind} / {new Date(source.createdAt).toLocaleString()}</span>
              </div>
              <SensitivityBadge sensitivity={source.defaultSensitivity} />
            </div>
          ))}
          {sources.length === 0 && <p className="muted">まだSourceがありません。</p>}
        </div>
      </div>
    </section>
  );
}

function ConnectionsView({
  connectors,
  policies,
  captureSettings,
  approvedFactCount,
  pendingCandidateCount,
  requestCount,
  updateCapture,
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
  stopAiAccess,
  refreshAiAccess,
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
  captureSettings: PassiveCaptureSettings;
  approvedFactCount: number;
  pendingCandidateCount: number;
  requestCount: number;
  updateCapture: (settings: Partial<PassiveCaptureSettings>) => void;
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
  stopAiAccess: () => void;
  refreshAiAccess: () => void;
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
  const captureExtensionIdReady = isLikelyChromeExtensionId(captureExtensionId);

  return (
    <section className="view-grid connections-grid">
      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI Connections</p>
            <h3>どのAIが、どの境界でVaultを使えるか</h3>
          </div>
          <ShieldCheck size={18} />
        </div>
        <div className="connection-list">
          {connectors.map((connector) => {
            const policy = policies.find((item) => item.clientId === connector.id);
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
              </article>
            );
          })}
        </div>
      </div>

      <div className={`panel wide readiness-panel ${accessReadiness.tone}`}>
        <div className="readiness-main">
          <div className="readiness-icon">
            {accessReadiness.tone === "ready" ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
          </div>
          <div>
            <p className="eyebrow">Connection readiness</p>
            <h3>{accessReadiness.title}</h3>
            <p>{accessReadiness.detail}</p>
          </div>
        </div>
        <div className="readiness-metrics">
          <Metric label="Approved Facts" value={approvedFactCount} />
          <Metric label="Inbox" value={pendingCandidateCount} />
          <Metric label="Requests" value={requestCount} />
          <Metric label="Capture" value={captureSettings.enabled ? "on" : "paused"} />
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">AI Access Service</p>
            <h3>普段使うAIへVaultを開く</h3>
          </div>
          <Activity size={18} />
        </div>
        <div className="service-console">
          <div className={`service-brief ${accessReadiness.tone}`}>
            <strong>{accessReadiness.title}</strong>
            <span>{accessReadiness.body}</span>
          </div>
          <div className="service-status-grid">
            <Metric label="Relay" value={aiServiceStatus?.relayReachable ? "reachable" : "offline"} />
            <Metric label="Agent" value={aiServiceStatus?.agentConnected ? "connected" : "offline"} />
            <Metric label="Managed" value={serviceManagedCopy(aiServiceStatus)} />
            <Metric label="MCP URL" value={aiServiceStatus?.mcpServerUrl ?? localRelayUrl} />
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
              {loginItemStatus?.plistPath && <span>{loginItemStatus.plistPath}</span>}
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
          </div>
          {aiServiceStatus?.lastError && <p className="warning-text">{aiServiceStatus.lastError}</p>}
          {!nativePath && <p className="muted">Desktop appで起動すると、ここからRelayとAgentを管理できます。</p>}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Local MCP setup</p>
            <h3>Claude Desktop / Codex系からVaultを呼び出す</h3>
          </div>
          <Plug size={18} />
        </div>
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
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Remote MCP Relay</p>
            <h3>ChatGPT / ClaudeからVault Agentへ接続する</h3>
          </div>
          <Radio size={18} />
        </div>
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
            <pre className="code-box">{JSON.stringify(makeRemoteConnectorInfo(), null, 2)}</pre>
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
        <p className="muted">Remote MCP RelayはOAuth/PKCEでAIクライアントを認可し、pairing済みLocal AgentへWebSocketで要求を渡します。RelayはOAuth client登録とリクエストの監査メタデータだけを永続化し、Vault本文・MCP本文・Context Pack本文は置きません。</p>
      </div>

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
          <p className="muted">Raw transcriptは初期設定で{captureSettings.retentionDays}日後に消えます。候補が承認されるまでFactにはなりません。</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Browser extension</p>
            <h3>AIチャット画面から直接Inboxへ送る</h3>
          </div>
          <Clipboard size={18} />
        </div>
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
      </div>

      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Manual capture</p>
            <h3>拡張が使えない時の入力</h3>
          </div>
          <Clipboard size={18} />
        </div>
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
  approvePackForAi,
  copyPackForAi,
  generateAnswer,
  denyActiveRequest
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
  approvePackForAi: (pack: ContextPack) => void;
  copyPackForAi: (pack: ContextPack) => void;
  generateAnswer: (pack: ContextPack) => void;
  denyActiveRequest: () => void;
}) {
  const aiReady =
    currentPack?.confirmationStatus === "confirmed" ||
    currentRequest?.status === "fulfilled";
  const requestClosed =
    currentRequest?.status === "denied" ||
    currentRequest?.status === "expired" ||
    currentPack?.confirmationStatus === "cancelled";

  return (
    <section className="ask-layout">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Incoming request</p>
            <h3>AIからのContext要求を模擬</h3>
          </div>
          <Send size={18} />
        </div>
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
          Requestを受ける
        </button>
        <div className="request-list">
          {requests.slice(0, 8).map((request) => (
            <button
              className={currentRequest?.id === request.id ? "request-row active" : "request-row"}
              key={request.id}
              onClick={() => setActiveRequest(request)}
              type="button"
            >
              <span>{request.clientName}</span>
              <strong>{requestStatusLabel(request.status)}</strong>
              <small>{request.taskText}</small>
            </button>
          ))}
          {requests.length === 0 && <p className="muted">まだContext Requestはありません。</p>}
        </div>
      </div>

      <div className="panel wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Context Pack</p>
            <h3>AIに渡す文脈の確認</h3>
          </div>
          {currentRequest && <Badge>{currentRequest.clientName}</Badge>}
        </div>
        {currentRequest && (
          <div className="request-detail">
            <Metric label="目的" value={currentRequest.purpose} />
            <Metric label="期限" value={formatDateTime(currentRequest.expiresAt)} />
            <Metric label="感度上限" value={<SensitivityBadge sensitivity={currentRequest.sensitivityCeiling} />} />
            <Metric label="状態" value={requestStatusLabel(currentRequest.status)} />
          </div>
        )}
        {!currentPack ? (
          <p className="muted">質問からContext Packを作成すると、ここに使用予定の背景情報が表示されます。</p>
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
            <div className="pack-summary">
              <Badge>{currentPack.riskLevel} risk</Badge>
              <SensitivityBadge sensitivity={currentPack.maxSensitivityIncluded} />
              <Badge>{packConfirmationLabel(currentPack.confirmationStatus)}</Badge>
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
                  <div>
                    <SensitivityBadge sensitivity={item.sensitivity} />
                    <span>{item.sourceTitles.join(", ")}</span>
                  </div>
                </div>
              ))}
              {currentPack.items.length === 0 && <p className="muted">使える承認済みFactがまだありません。</p>}
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
            <div className="action-row">
              <button
                className="primary-button"
                disabled={requestClosed || aiReady}
                onClick={() => approvePackForAi(currentPack)}
                type="button"
              >
                <CheckCircle2 size={16} />
                AIへ返すために承認
              </button>
              <button
                className="secondary-button"
                disabled={requestClosed}
                onClick={() => copyPackForAi(currentPack)}
                type="button"
              >
                <Clipboard size={16} />
                承認済みPackをコピー
              </button>
              <button
                className="secondary-button"
                disabled={requestClosed}
                onClick={() => generateAnswer(currentPack)}
                type="button"
              >
                <Check size={16} />
                ローカル回答を生成
              </button>
              <button className="danger-button" disabled={requestClosed} onClick={denyActiveRequest} type="button">
                <X size={16} />
                拒否
              </button>
            </div>
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
  results,
  searchMode,
  searchError,
  nativePath
}: {
  query: string;
  setQuery: (value: string) => void;
  domainFilter: LifeContextDomain | "all";
  setDomainFilter: (value: LifeContextDomain | "all") => void;
  sensitivityFilter: SensitivityTier | "all";
  setSensitivityFilter: (value: SensitivityTier | "all") => void;
  results: ApprovedFact[];
  searchMode: SearchMode;
  searchError: string | null;
  nativePath: string | null;
}) {
  const modeCopy = searchModeCopy(searchMode, Boolean(nativePath));
  return (
    <section className="panel wide">
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
          <FactRow fact={fact} key={fact.id} />
        ))}
        {results.length === 0 && <p className="muted">一致するApprovedFactがありません。</p>}
      </div>
    </section>
  );
}

function SettingsView({
  passphrase,
  setPassphrase,
  backupText,
  setBackupText,
  exportBackup,
  restoreBackup,
  clearVault,
  seedDemo,
  nativePath,
  nativeRevision,
  storageReady
}: {
  passphrase: string;
  setPassphrase: (value: string) => void;
  backupText: string;
  setBackupText: (value: string) => void;
  exportBackup: () => void;
  restoreBackup: () => void;
  clearVault: () => void;
  seedDemo: () => void;
  nativePath: string | null;
  nativeRevision: string | null;
  storageReady: boolean;
}) {
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
          <button className="secondary-button" onClick={restoreBackup} type="button">
            <Upload size={16} />
            Restore
          </button>
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
            <p className="eyebrow">Demo</p>
            <h3>検証用操作</h3>
          </div>
        </div>
        <div className="action-column">
          <button className="secondary-button" onClick={seedDemo} type="button">
            <Sparkles size={16} />
            デモデータ投入
          </button>
          <button className="danger-button" onClick={clearVault} type="button">
            <X size={16} />
            Vaultをクリア
          </button>
        </div>
      </div>
    </section>
  );
}

function AuditView({ events }: { events: VaultState["auditEvents"] }) {
  return (
    <section className="panel wide">
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
              <strong>{event.eventType}</strong>
              <span>
                {event.subjectType} / {new Date(event.occurredAt).toLocaleString()}
              </span>
            </div>
            <div className="audit-meta">
              <SensitivityBadge sensitivity={event.sensitivity} />
              <Badge>{event.actor}</Badge>
            </div>
          </div>
        ))}
        {events.length === 0 && <p className="muted">まだ監査イベントはありません。</p>}
      </div>
    </section>
  );
}

function FactRow({ fact }: { fact: ApprovedFact }) {
  return (
    <div className="fact-row">
      <div>
        <strong>{fact.factText}</strong>
        <span>{domainLabel(fact.domain)} / {fact.confidence}</span>
      </div>
      <SensitivityBadge sensitivity={fact.sensitivity} />
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text"
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} type={type} />
    </label>
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
  return (
    <label className="field">
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
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
    approved: "低リスク・未返却",
    denied: "拒否済み",
    fulfilled: "AI返却可",
    expired: "期限切れ"
  };
  return labels[status];
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
    provider_policy: "AI接続ポリシーで制限",
    expired: "期限切れ",
    deleted: "削除済み",
    user_hidden: "ユーザ非表示",
    not_relevant: "今回の目的と不一致",
    secret_never_send: "送信禁止"
  };
  return labels[reason];
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
  if (!status) return "desktop only";
  if (status.relayManagedRunning && status.agentManagedRunning) return "relay + agent";
  if (status.relayManagedRunning) return "relay";
  if (status.agentManagedRunning) return "agent";
  if (status.relayReachable || status.agentConnected) return "external";
  return "stopped";
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
  if (status?.agentConnected) {
    return {
      badge: "Ready",
      title: "AIがContext Packを要求できる状態です",
      body: "RelayとLocal Agentが接続済みです。",
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
    body: "Start AI AccessでRelayとLocal Agentをまとめて起動します。",
    detail:
      "最初は背景情報を承認してから起動すると、AIに渡すContext Packの確認まで一気に試せます。",
    tone: "neutral"
  };
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

function makeRelayStatePath(nativePath: string | null): string {
  if (nativePath) {
    return nativePath.replace(/vault\.sqlite3$/, "relay-state.json");
  }
  return "$HOME/Library/Application Support/dev.life-context-vault.poc/relay-state.json";
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

function makeRemoteConnectorInfo() {
  return {
    mcpServerUrl: localRelayUrl,
    authorizationServerMetadata: `${localRelayBaseUrl}/.well-known/oauth-authorization-server`,
    protectedResourceMetadata: `${localRelayBaseUrl}/.well-known/oauth-protected-resource`,
    dynamicClientRegistration: `${localRelayBaseUrl}/oauth/register`,
    relayStateStatus: `${localRelayBaseUrl}/relay/state`,
    scopes: [
      "context_pack.request",
      "memory.propose",
      "policy.read",
      "request.status"
    ]
  };
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
