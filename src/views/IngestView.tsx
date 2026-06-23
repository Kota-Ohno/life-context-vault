/**
 * IngestView — unified 取り込み pillar (candidate review + sources).
 *
 * Merges InboxView and SourcesView into one Quiet Vault screen.
 * All handler props are forwarded verbatim; no approval/lifecycle/boundary logic changed.
 */

import { useState, useEffect, useId } from "react";
import {
  Archive,
  Check,
  CheckCircle2,
  FileText,
  Plug,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import type {
  ApprovedFact,
  MemoryCandidate,
  SensitivityTier,
  SourceLifecycleAction,
  SourceBodyUpdate,
  SourceMetadataUpdate,
  VaultState,
} from "../types";
import { domainLabel, sensitivityLabel } from "../vault";
import { candidateMemoryStatus, memoryStatusLabel } from "../memoryStatus";
import { PageHeader } from "../components/PageHeader";
import { SectionDivider } from "../components/SectionDivider";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { SensitivityBadge } from "../components/SensitivityBadge";
import { EmptyState } from "../components/EmptyState";

// ─── Local types (kept in parity with App.tsx private types) ─────────────────

export type UploadFeedbackTone = "ready" | "attention";

export interface UploadFeedback {
  tone: UploadFeedbackTone;
  title: string;
  body: string;
}

interface DocumentReadinessItem {
  label: string;
  state: "ready" | "attention";
  value: string;
  detail: string;
}

// ─── Local utility mirrors (keep in sync with App.tsx) ───────────────────────

function sourceLifecycleLabel(state: VaultState["sources"][number]["deletionState"]): string {
  const labels: Record<VaultState["sources"][number]["deletionState"], string> = {
    active: "使用中",
    soft_deleted: "停止中",
    purged: "本文消去済み",
  };
  return labels[state];
}

function sourceRetentionLabel(source: VaultState["sources"][number]): string | null {
  if (source.promotedToLongTerm) return "長期保持";
  if (source.retentionUntil) return `TTL ${new Date(source.retentionUntil).toLocaleDateString()}`;
  return null;
}

function documentIngestionReadiness(
  ocrAvailable: boolean,
  ocrLabel: string | null,
  officeAvailable: boolean,
  officeLabel: string | null
): DocumentReadinessItem[] {
  return [
    {
      label: "PDF / DOCX等",
      state: "ready",
      value: "対応",
      detail: "ローカル抽出",
    },
    {
      label: "画像 (OCR)",
      state: ocrAvailable ? "ready" : "attention",
      value: ocrAvailable ? ocrLabel ?? "OCR変換ツール" : "未設定",
      detail: ocrAvailable ? "ローカル実行" : "接続が必要です",
    },
    {
      label: "旧Office形式",
      state: officeAvailable ? "ready" : "attention",
      value: officeAvailable ? officeLabel ?? "Office変換ツール" : "未設定",
      detail: officeAvailable ? "ローカル変換" : "接続が必要です",
    },
  ];
}

const SENSITIVITY_OPTIONS: SensitivityTier[] = [
  "public",
  "personal",
  "private_consequential",
  "sensitive",
  "secret_never_send",
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function FieldInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

function FieldTextarea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IngestViewProps {
  /* ── Candidate review ── */
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
  goConnections: () => void;

  /* ── Sources ── */
  sources: VaultState["sources"];
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
}

// ─── IngestView ───────────────────────────────────────────────────────────────

export function IngestView({
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
  goConnections,
  sources,
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
}: IngestViewProps) {
  const [isDragActive, setIsDragActive] = useState(false);
  const pendingCount = candidates.length;
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
    <div className="qv-ingest">
      <PageHeader
        eyebrow="取り込み"
        title="記憶の入り口"
        lede="生活背景・文書・AI会話から記憶を生み出し、あなたが選んだものだけを残します。"
      />

      {/* ── Section 1: Candidate Review ───────────────────────────── */}
      <SectionDivider
        label={pendingCount > 0 ? `確認待ちの記憶 — ${pendingCount}件` : "確認待ちの記憶"}
      />

      {candidates.length === 0 ? (
        <EmptyState
          title="確認待ちの記憶はありません"
          body="取り込み元・メモ・AI会話から記憶を作ると、ここに届きます。"
          action={
            <div className="qv-ingest__empty-actions">
              <Button variant="primary" onClick={goHome}>
                <Sparkles size={15} />
                背景情報を追加
              </Button>
              <Button variant="ghost" onClick={goConnections}>
                <Plug size={15} />
                AI会話連携を設定
              </Button>
              <div className="qv-ingest__trust-note">
                <ShieldCheck size={14} />
                <span>記憶は承認後にAIへ渡せるようになり、確認後だけAIに渡ります。</span>
              </div>
            </div>
          }
        />
      ) : (
        <div className="qv-ingest__candidate-list">
          {candidates.map((candidate) => {
            const conflictFactIds = candidate.conflictWithFactIds ?? [];
            const conflictOptions = facts.filter((f) => conflictFactIds.includes(f.id));
            const replacementOptions = [
              ...conflictOptions,
              ...facts.filter(
                (f) =>
                  f.domain === candidate.domain &&
                  f.status === "active" &&
                  !conflictFactIds.includes(f.id)
              ),
            ].slice(0, 4);
            const selectedSupersedes = supersedes[candidate.id] ?? [];

            return (
              <Card as="article" tone="pending" className="qv-ingest__cand-card" key={candidate.id}>
                {/* Meta row */}
                <div className="qv-ingest__cand-meta">
                  <span className="qv-ingest__cand-domain">{domainLabel(candidate.domain)}</span>
                  <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
                  <span className="qv-ingest__cand-status">
                    {memoryStatusLabel(candidateMemoryStatus(candidate.status))}
                  </span>
                  {conflictFactIds.length > 0 && (
                    <span className="qv-ingest__conflict-tag">衝突する記憶</span>
                  )}
                </div>

                {/* Editable text */}
                <textarea
                  aria-label="Candidate text"
                  className="qv-ingest__cand-text"
                  value={edits[candidate.id] ?? candidate.proposedFactText}
                  onChange={(e) => setEdit(candidate.id, e.target.value)}
                />

                <p className="qv-ingest__cand-reason">{candidate.reasonToRemember}</p>

                {/* Conflict warning */}
                {conflictFactIds.length > 0 && (
                  <div className="qv-ingest__warning-line">
                    <ShieldAlert size={14} />
                    {candidate.conflictReason ?? "既存の記憶と異なる可能性があります。保存前に置き換えるか確認してください。"}
                  </div>
                )}

                {/* Supersede options */}
                {replacementOptions.length > 0 && (
                  <div className="qv-ingest__supersede">
                    <div className="qv-ingest__trust-note qv-ingest__trust-note--compact">
                      <RefreshCw size={13} />
                      <span>古い記憶を置き換える場合だけ選択します。置き換えた記憶はAIに渡らなくなり、履歴に残ります。</span>
                    </div>
                    <div className="qv-ingest__supersede-options">
                      {replacementOptions.map((fact) => (
                        <label className="qv-ingest__supersede-option" key={fact.id}>
                          <input
                            checked={selectedSupersedes.includes(fact.id)}
                            onChange={() => toggleSupersede(candidate.id, fact.id)}
                            type="checkbox"
                          />
                          <span>{fact.factText}</span>
                          {conflictFactIds.includes(fact.id) && (
                            <span className="qv-ingest__conflict-tag">衝突</span>
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {/* Sensitive warning */}
                {candidate.status === "blocked_sensitive" && (
                  <div className="qv-ingest__warning-line">
                    <ShieldAlert size={14} />
                    要確認の記憶です。保存するとAIに渡す前に毎回確認します。
                  </div>
                )}

                {/* Action row */}
                <div className="qv-ingest__cand-actions">
                  <Button variant="primary" size="sm" onClick={() => approve(candidate)}>
                    <Check size={14} />
                    この記憶を承認
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => markSensitive(candidate)}>
                    <ShieldAlert size={14} />
                    要確認にする
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => archive(candidate)}>
                    <Archive size={14} />
                    あとで
                  </Button>
                  <Button variant="quiet" size="sm" onClick={() => reject(candidate)}>
                    <X size={14} />
                    却下
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Section 2: Sources ────────────────────────────────────── */}
      <SectionDivider label="取り込み済み" />

      {/* Add source inputs */}
      <div className="qv-ingest__add-row">
        {/* Manual text */}
        <Card className="qv-ingest__add-card">
          <p className="qv-ingest__add-eyebrow">会話・メモから追加</p>
          <div className="qv-ingest__trust-note">
            <ShieldCheck size={14} />
            <span>ここで保存されるのは取り込み元と未承認の記憶です。AIへ渡るのは承認した記憶だけです。</span>
          </div>
          <div className="qv-ingest__form-stack">
            <FieldInput label="タイトル" value={manualTitle} onChange={setManualTitle} placeholder="例: 引っ越しの相談メモ" />
            <FieldTextarea label="本文" value={manualBody} onChange={setManualBody} placeholder="生活背景として覚えておくと役立つ内容" />
            <Button variant="primary" onClick={addManualSource}>
              <Sparkles size={15} />
              記憶を生成
            </Button>
          </div>
        </Card>

        {/* File upload */}
        <Card className="qv-ingest__add-card">
          <p className="qv-ingest__add-eyebrow">文書を追加</p>
          <label
            aria-label={`文書を追加: ${sourceLabel}`}
            className={isDragActive ? "qv-ingest__drop-zone qv-ingest__drop-zone--active" : "qv-ingest__drop-zone"}
            onDragEnter={handleDropZoneDrag}
            onDragLeave={handleDropZoneLeave}
            onDragOver={handleDropZoneDrag}
            onDrop={handleDropZoneDrop}
          >
            <Upload size={22} />
            <strong>{isDragActive ? "ここにドロップ" : "ファイルを選択 / ドロップ"}</strong>
            <span className="qv-ingest__drop-label">{sourceLabel}</span>
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
            <div className={`qv-ingest__upload-feedback qv-ingest__upload-feedback--${uploadFeedback.tone}`}>
              {uploadFeedback.tone === "ready" ? <CheckCircle2 size={15} /> : <ShieldAlert size={15} />}
              <div>
                <strong>{uploadFeedback.title}</strong>
                <span>{uploadFeedback.body}</span>
              </div>
            </div>
          )}
          <div className="qv-ingest__trust-note">
            <ShieldCheck size={14} />
            <span>
              PDF/OfficeはDesktopでローカル抽出します。
              {ocrExtractionAvailable
                ? ` 画像は ${ocrProviderLabel ?? "OCR変換ツール"} をローカル実行して抽出します。`
                : " 画像OCRは変換ツール接続まで取り込めません。"}
              {legacyOfficeConversionAvailable
                ? ` 旧Office形式は ${legacyOfficeProviderLabel ?? "Office変換ツール"} でローカル変換します。`
                : " 旧Office形式は変換ツール接続まで取り込めません。"}
            </span>
          </div>
          <div className="qv-ingest__readiness-grid" aria-label="Document ingestion readiness">
            {documentReadiness.map((item) => (
              <div className={`qv-ingest__readiness-card qv-ingest__readiness-card--${item.state}`} key={item.label}>
                {item.state === "ready" ? <CheckCircle2 size={13} /> : <ShieldAlert size={13} />}
                <div>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.detail}</small>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Source history */}
      <div className="qv-ingest__trust-note qv-ingest__source-lifecycle-note">
        <Archive size={14} />
        <span>取り込み元を停止または本文消去すると、確認待ちの記憶はあとでへ移り、関連する記憶は再確認待ちになります。</span>
      </div>

      {sources.length === 0 ? (
        <EmptyState
          title="まだ取り込み元がありません"
          body="メモや文書を追加すると、ここに記録が残ります。"
          action={
            <div className="qv-ingest__empty-actions">
              <Button variant="ghost" onClick={goHome}>
                <FileText size={15} />
                背景情報を追加
              </Button>
            </div>
          }
        />
      ) : (
        <div className="qv-ingest__source-list">
          {sources.map((source) => {
            const linkedCandidateCount = candidates.filter((c) =>
              c.sourceIds.includes(source.id)
            ).length;
            const linkedFacts = facts.filter((f) => f.sourceIds.includes(source.id));
            const linkedFactCount = linkedFacts.length;
            const linkedPackCount = contextPacks.filter((pack) =>
              pack.items.some((item) => linkedFacts.some((f) => f.id === item.factId))
            ).length;
            return (
              <IngestSourceRow
                changeSourceLifecycle={changeSourceLifecycle}
                editSourceBody={editSourceBody}
                editSourceMetadata={editSourceMetadata}
                key={source.id}
                linkedCandidateCount={linkedCandidateCount}
                linkedFactCount={linkedFactCount}
                linkedPackCount={linkedPackCount}
                source={source}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── IngestSourceRow ──────────────────────────────────────────────────────────

function IngestSourceRow({
  source,
  linkedCandidateCount,
  linkedFactCount,
  linkedPackCount,
  changeSourceLifecycle,
  editSourceMetadata,
  editSourceBody,
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
    <Card as="article" className="qv-ingest__source-row">
      <div className="qv-ingest__source-main">
        {bodyDraft !== null ? (
          <div className="qv-ingest__source-edit">
            <FieldTextarea
              label="取り込み元の原文"
              value={bodyDraft}
              onChange={setBodyDraft}
              placeholder="再抽出したい本文"
            />
            <div className="qv-ingest__trust-note">
              <RefreshCw size={13} />
              <span>保存すると未承認の記憶を作り直します。承認済みの記憶は再確認待ちになり、AIに渡した内容（記憶）は無効化されます。</span>
            </div>
          </div>
        ) : draft ? (
          <div className="qv-ingest__source-edit">
            <FieldInput
              label="取り込み元のタイトル"
              value={draft.title}
              onChange={(value) => setDraft({ ...draft, title: value })}
              placeholder="根拠として見分けやすい名前"
            />
            <div className="qv-ingest__source-edit-grid">
              <label className="field">
                <span>取り込み元の感度</span>
                <select
                  value={draft.defaultSensitivity}
                  onChange={(event) =>
                    setDraft({ ...draft, defaultSensitivity: event.target.value as SensitivityTier })
                  }
                >
                  {SENSITIVITY_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {sensitivityLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              {canPromote && (
                <label className="qv-ingest__long-term-toggle">
                  <input
                    checked={Boolean(draft.promotedToLongTerm)}
                    onChange={(event) =>
                      setDraft({ ...draft, promotedToLongTerm: event.target.checked })
                    }
                    type="checkbox"
                  />
                  <div>
                    <strong>長期保持</strong>
                    <span>
                      {source.retentionUntil
                        ? new Date(source.retentionUntil).toLocaleDateString()
                        : ""}
                    </span>
                  </div>
                </label>
              )}
            </div>
          </div>
        ) : (
          <>
            <strong className="qv-ingest__source-title">{source.title}</strong>
            <span className="qv-ingest__source-kind">
              {source.kind} / {new Date(source.createdAt).toLocaleString()}
            </span>
            <div className="qv-ingest__source-badges">
              <span className="qv-ingest__source-badge">{sourceLifecycleLabel(source.deletionState)}</span>
              <span className="qv-ingest__source-badge">{source.body ? "本文あり" : "本文なし"}</span>
              {retentionLabel && <span className="qv-ingest__source-badge">{retentionLabel}</span>}
              <span className="qv-ingest__source-badge">確認待ち {linkedCandidateCount}</span>
              <span className="qv-ingest__source-badge">承認済み {linkedFactCount}</span>
              <span className="qv-ingest__source-badge">AIに渡した {linkedPackCount}</span>
            </div>
            {confirmBodyPurge && (
              <div className="qv-ingest__purge-confirm" role="status">
                <strong>この取り込み元の原文を消去します</strong>
                <span>
                  本文は戻せません。確認待ちの記憶 {linkedCandidateCount}件、関連する記憶 {linkedFactCount}件、
                  AIに渡した内容（記憶）{linkedPackCount}件に影響します。
                </span>
                <Button variant="quiet" size="sm" onClick={() => setConfirmBodyPurge(false)}>
                  <X size={13} />
                  取消
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="qv-ingest__source-actions">
        <SensitivityBadge sensitivity={source.defaultSensitivity} />

        {bodyDraft !== null ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                const saved = await editSourceBody(source.id, { body: bodyDraft });
                if (saved) setBodyDraft(null);
              }}
            >
              <RefreshCw size={13} />
              保存して再抽出
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setBodyDraft(null)}>
              <X size={13} />
              取消
            </Button>
          </>
        ) : draft ? (
          <>
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                const saved = await editSourceMetadata(source.id, draft);
                if (saved) setDraft(null);
              }}
            >
              <Check size={13} />
              保存
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setDraft(null)}>
              <X size={13} />
              取消
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="quiet"
              size="sm"
              onClick={() =>
                setDraft({
                  title: source.title,
                  defaultSensitivity: source.defaultSensitivity,
                  promotedToLongTerm: source.promotedToLongTerm ?? false,
                })
              }
            >
              <Settings size={13} />
              編集
            </Button>
            {source.deletionState === "active" && source.body && (
              <Button
                variant="quiet"
                size="sm"
                onClick={() => setBodyDraft(source.body)}
              >
                <RefreshCw size={13} />
                本文編集
              </Button>
            )}
          </>
        )}

        {source.deletionState === "active" && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => changeSourceLifecycle(source.id, "soft_delete")}
          >
            <Archive size={13} />
            使用停止
          </Button>
        )}
        {source.deletionState === "soft_deleted" && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => changeSourceLifecycle(source.id, "restore")}
          >
            <RefreshCw size={13} />
            復元
          </Button>
        )}
        {source.deletionState !== "purged" && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              if (!confirmBodyPurge) {
                setConfirmBodyPurge(true);
                return;
              }
              setConfirmBodyPurge(false);
              changeSourceLifecycle(source.id, "purge_body");
            }}
          >
            <X size={13} />
            {confirmBodyPurge ? "確認して本文消去" : "本文消去"}
          </Button>
        )}
      </div>
    </Card>
  );
}
