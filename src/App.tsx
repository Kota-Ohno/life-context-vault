import {
  Activity,
  Archive,
  Check,
  Clipboard,
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
  Search,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getNativeVaultPath, loadNativeVault, saveNativeVault } from "./nativeStorage";
import {
  addSourceWithCandidates,
  addPassiveCaptureEvent,
  approveCandidate,
  attachLocalAnswer,
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
  ConnectorKind,
  ConnectorSession,
  ContextPack,
  ContextPackRequest,
  LifeContextDomain,
  MemoryCandidate,
  PassiveCaptureSettings,
  SensitivityTier,
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
  const [searchQuery, setSearchQuery] = useState("");
  const [domainFilter, setDomainFilter] = useState<LifeContextDomain | "all">("all");
  const [sensitivityFilter, setSensitivityFilter] = useState<SensitivityTier | "all">("all");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupText, setBackupText] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function hydrateNativeStorage() {
      try {
        const [nativeVault, path] = await Promise.all([loadNativeVault(), getNativeVaultPath()]);
        if (cancelled) return;
        if (nativeVault) setState(nativeVault);
        setNativePath(path);
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
    saveVault(state);
    void saveNativeVault(state);
  }, [state, storageReady]);

  useEffect(() => {
    if (!storageReady) return;
    setState((current) => purgeExpiredPassiveCaptures(current));
  }, [storageReady]);

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
  const searchResults = useMemo(
    () =>
      searchFacts(state, searchQuery, {
        domain: domainFilter,
        sensitivity: sensitivityFilter
      }),
    [domainFilter, searchQuery, sensitivityFilter, state]
  );

  function apply(next: VaultState, message?: string) {
    setState(next);
    if (message) setNotice(message);
  }

  function submitBackground() {
    const next = createBackgroundSource(state, setup);
    apply(next, "背景候補をMemory Inboxに追加しました。");
    setSetup(blankSetup);
    setView("inbox");
  }

  function addManualSource() {
    if (!manualBody.trim()) {
      setNotice("メモ本文を入力してください。");
      return;
    }
    const next = addSourceWithCandidates(state, {
      kind: "manual_note",
      origin: "manual_entry",
      title: manualTitle || "Manual note",
      body: manualBody
    });
    apply(next, "Sourceを追加し、記憶候補を生成しました。");
    setManualTitle("");
    setManualBody("");
    setView("inbox");
  }

  async function handleFileUpload(file: File) {
    const text = await file.text();
    const next = addSourceWithCandidates(state, {
      kind: "document",
      origin: "user_upload",
      title: file.name,
      body: text
    });
    apply(next, `${file.name} から記憶候補を生成しました。`);
    setView("inbox");
  }

  function approve(candidate: MemoryCandidate) {
    const edited = candidateEdits[candidate.id];
    const next = approveCandidate(state, candidate.id, edited);
    apply(next, "承認済みFactとして保存しました。");
  }

  function buildPack() {
    if (!question.trim()) {
      setNotice("質問を入力してください。");
      return;
    }
    const client = state.connectorSessions.find((session) => session.id === requestClientId);
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
    let next = state;
    if (pack.confirmationStatus === "pending_user_confirmation") {
      next = confirmContextPack(next, pack.id);
    }
    next = attachLocalAnswer(next, pack.id, answer);
    apply(next, "ローカル回答を生成しました。");
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
          {notice && (
            <button className="notice" onClick={() => setNotice("")} type="button">
              {notice}
            </button>
          )}
        </header>

        {view === "home" && (
          <HomeView
            facts={activeFacts}
            candidates={activeCandidates}
            connectors={state.connectorSessions}
            captureSettings={state.passiveCaptureSettings}
            setup={setup}
            setSetup={setSetup}
            submitBackground={submitBackground}
            seedDemo={seedDemo}
            goInbox={() => setView("inbox")}
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
            reject={(candidate) => apply(updateCandidateStatus(state, candidate.id, "rejected"), "候補を却下しました。")}
            archive={(candidate) => apply(updateCandidateStatus(state, candidate.id, "archived"), "候補をLaterに移しました。")}
            markSensitive={(candidate) => apply(updateCandidateStatus(state, candidate.id, "blocked_sensitive"), "候補をセンシティブ扱いにしました。")}
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
            updateCapture={updateCapture}
            captureClient={captureClient}
            setCaptureClient={setCaptureClient}
            captureConversationId={captureConversationId}
            setCaptureConversationId={setCaptureConversationId}
            captureText={captureText}
            setCaptureText={setCaptureText}
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
  setup,
  setSetup,
  submitBackground,
  seedDemo,
  goInbox,
  goRequests,
  goConnections
}: {
  facts: ApprovedFact[];
  candidates: MemoryCandidate[];
  connectors: ConnectorSession[];
  captureSettings: PassiveCaptureSettings;
  setup: BackgroundSetupInput;
  setSetup: (input: BackgroundSetupInput) => void;
  submitBackground: () => void;
  seedDemo: () => void;
  goInbox: () => void;
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

  return (
    <section className="view-grid home-grid">
      <div className="panel wide">
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
        <p className="muted">PDF/OCRはTauri版以降の抽出パイプラインに分離予定です。</p>
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
  updateCapture,
  captureClient,
  setCaptureClient,
  captureConversationId,
  setCaptureConversationId,
  captureText,
  setCaptureText,
  simulatePassiveCapture
}: {
  connectors: ConnectorSession[];
  policies: VaultState["accessPolicies"];
  captureSettings: PassiveCaptureSettings;
  updateCapture: (settings: Partial<PassiveCaptureSettings>) => void;
  captureClient: ConnectorKind;
  setCaptureClient: (value: ConnectorKind) => void;
  captureConversationId: string;
  setCaptureConversationId: (value: string) => void;
  captureText: string;
  setCaptureText: (value: string) => void;
  simulatePassiveCapture: () => void;
}) {
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
            <p className="eyebrow">Capture simulator</p>
            <h3>ブラウザ拡張の入力を模擬</h3>
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
  generateAnswer,
  denyActiveRequest
}: {
  question: string;
  setQuestion: (value: string) => void;
  requestClientId: string;
  setRequestClientId: (value: string) => void;
  connectors: ConnectorSession[];
  buildPack: () => void;
  requests: ContextPackRequest[];
  setActiveRequest: (request: ContextPackRequest) => void;
  currentRequest: ContextPackRequest | null;
  currentPack: ContextPack | null;
  generateAnswer: (pack: ContextPack) => void;
  denyActiveRequest: () => void;
}) {
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
              <strong>{request.status}</strong>
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
        {!currentPack ? (
          <p className="muted">質問からContext Packを作成すると、ここに使用予定の背景情報が表示されます。</p>
        ) : (
          <div className="context-pack">
            <div className="pack-summary">
              <Badge>{currentPack.riskLevel} risk</Badge>
              <SensitivityBadge sensitivity={currentPack.maxSensitivityIncluded} />
              <Badge>{currentPack.confirmationStatus}</Badge>
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
              <p className="muted">{currentPack.excludedItems.length}件はポリシーにより除外されています。</p>
            )}
            <div className="action-row">
              <button className="primary-button" onClick={() => generateAnswer(currentPack)} type="button">
                <Check size={16} />
                承認して回答生成
              </button>
              <button className="danger-button" onClick={denyActiveRequest} type="button">
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
  results
}: {
  query: string;
  setQuery: (value: string) => void;
  domainFilter: LifeContextDomain | "all";
  setDomainFilter: (value: LifeContextDomain | "all") => void;
  sensitivityFilter: SensitivityTier | "all";
  setSensitivityFilter: (value: SensitivityTier | "all") => void;
  results: ApprovedFact[];
}) {
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
              <strong>{nativePath ? "Native SQLite" : "Browser localStorage"}</strong>
              <span>{nativePath ?? "Tauri外ではブラウザのlocalStorageに保存します。"}</span>
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

function groupByDomain(facts: ApprovedFact[]): Partial<Record<LifeContextDomain, ApprovedFact[]>> {
  return facts.reduce<Partial<Record<LifeContextDomain, ApprovedFact[]>>>((acc, fact) => {
    acc[fact.domain] = [...(acc[fact.domain] ?? []), fact];
    return acc;
  }, {});
}
