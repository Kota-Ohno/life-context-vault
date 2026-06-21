import { useMemo, useState } from "react";
import {
  buildActivityTimeline,
  type TimelineEntry,
  type TimelineDay,
} from "../vault";
import type { VaultState } from "../types";
import { PageHeader } from "./PageHeader";
import { Chip } from "./Chip";
import { Card } from "./Card";
import { BoundaryRule } from "./BoundaryRule";
import { Tag } from "./Tag";
import { Seal } from "./Seal";
import { Button } from "./Button";

// ─── Types ────────────────────────────────────────────────────────────────────

type Scope = "week" | "month" | "all";

export interface HomeTimelineProps {
  state: VaultState;
  goSources: () => void;
  goConnections: () => void;
  seedDemo: () => void;
  onApprovePending?: (packId: string) => void;
  onApproveStanding?: (packId: string, clientId: string) => void;
  onRevoke?: (packId: string) => void;
}

// ─── Client glyph ─────────────────────────────────────────────────────────────

const CLIENT_GLYPHS: Record<string, { letter: string; cls: string }> = {
  chatgpt: { letter: "G", cls: "qv-tl-glyph--gpt" },
  openai:  { letter: "G", cls: "qv-tl-glyph--gpt" },
  claude:  { letter: "C", cls: "qv-tl-glyph--claude" },
  codex:   { letter: "X", cls: "qv-tl-glyph--codex" },
};

function clientGlyph(clientId: string, clientName: string) {
  const key = clientId.toLowerCase().replace(/[^a-z]/g, "");
  const match =
    CLIENT_GLYPHS[key] ??
    Object.entries(CLIENT_GLYPHS).find(([k]) => key.includes(k))?.[1];
  if (match) return match;
  // Fallback: first letter of clientName
  return {
    letter: (clientName || "?").charAt(0).toUpperCase(),
    cls: "qv-tl-glyph--default",
  };
}

// ─── Time label ───────────────────────────────────────────────────────────────

function timeLabel(at: string): string {
  try {
    const d = new Date(at);
    return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// ─── Sensitivity display ──────────────────────────────────────────────────────

function sensitivityShort(s: string): string {
  return s;
}

// ─── Single entry card ────────────────────────────────────────────────────────

function EntryCard({
  entry,
  onApprovePending,
  onApproveStanding,
  onRevoke,
}: {
  entry: TimelineEntry;
  onApprovePending?: (packId: string) => void;
  onApproveStanding?: (packId: string, clientId: string) => void;
  onRevoke?: (packId: string) => void;
}) {
  const isPending = entry.disclosure === "pending";
  const isCancelled = entry.disclosure === "cancelled";
  const isConfirmed = entry.disclosure === "confirmed";
  const glyph = clientGlyph(entry.clientId, entry.clientName);

  // I1: cancelled packs must never look like a successful disclosure.
  // M2: confirmed (user pressed 今回だけ) gets a distinct label from auto.
  const boundaryLabel = isPending ? "承認すると渡る内容" : "AIに渡った内容";
  const sealVariant = isPending ? "pending" : "auto";
  const sealLabel = isPending
    ? "あなたの承認待ち"
    : isConfirmed
    ? "確認して渡しました"
    : "自動で渡しました";
  const sealDetail = `${sensitivityShort(entry.maxSensitivity)} · ${isPending ? "閾値より上" : "即時"}`;

  return (
    <Card
      as="article"
      tone={isPending ? "pending" : "default"}
      className={["qv-tl-entry", isPending && "qv-tl-entry--pending"].filter(Boolean).join(" ")}
    >
      {/* Entry head: client glyph + name + time */}
      <div className="qv-tl-entry-head">
        <span className="qv-tl-client">
          <span className={["qv-tl-glyph", glyph.cls].join(" ")}>{glyph.letter}</span>
          <span className="qv-tl-client-name">{entry.clientName}</span>
        </span>
        <time className="qv-tl-time" dateTime={entry.at}>{timeLabel(entry.at)}</time>
      </div>

      {/* Task line — Mincho font via CSS */}
      {entry.task && (
        <p className="qv-tl-task">
          <span className="qv-tl-task__q">「</span>
          {entry.task}
          <span className="qv-tl-task__q">」</span>
        </p>
      )}

      {/* Boundary rule */}
      <BoundaryRule label={boundaryLabel} />

      {/* Fact pills */}
      {entry.facts.length > 0 && (
        <div className="qv-tl-facts">
          {entry.facts.map((f) => (
            <Tag
              key={f.factId}
              category={f.category || "—"}
              value={f.text}
              sealed={isPending}
            />
          ))}
        </div>
      )}

      {/* Entry footer — I1: cancelled shows muted note, no Seal, no action buttons */}
      <div className="qv-tl-entry-foot">
        {isCancelled ? (
          <span className="qv-tl-cancelled-note" aria-label="取り消し済み">
            取り消し済み — このAIには渡していません
          </span>
        ) : (
          <>
            <Seal variant={sealVariant} label={sealLabel} detail={sealDetail} />

            {isPending ? (
              <span className="qv-tl-approve">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onApprovePending?.(entry.packId)}
                >
                  今回だけ
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => onApproveStanding?.(entry.packId, entry.clientId)}
                >
                  今後このAIに自動
                </Button>
              </span>
            ) : (
              <button
                type="button"
                className="qv-tl-revoke"
                onClick={() => onRevoke?.(entry.packId)}
              >
                取り消す
              </button>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ─── Day section ──────────────────────────────────────────────────────────────

function DaySection({
  day,
  onApprovePending,
  onApproveStanding,
  onRevoke,
}: {
  day: TimelineDay;
  onApprovePending?: (packId: string) => void;
  onApproveStanding?: (packId: string, clientId: string) => void;
  onRevoke?: (packId: string) => void;
}) {
  return (
    <section className="qv-tl-day">
      <div className="qv-tl-day-head">
        <h2 className="qv-tl-day-label">{day.label}</h2>
        <div className="qv-tl-day-rule" aria-hidden="true" />
      </div>
      {day.entries.map((entry) => (
        <EntryCard
          key={entry.packId}
          entry={entry}
          onApprovePending={onApprovePending}
          onApproveStanding={onApproveStanding}
          onRevoke={onRevoke}
        />
      ))}
    </section>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

const PENDING_STATUSES = new Set<string>(["new", "needs_user_detail", "blocked_sensitive"]);

function TimelineEmpty({
  scope,
  factCount,
  pendingCandidateCount,
  goSources,
  goConnections,
  seedDemo,
}: {
  scope: Scope;
  factCount: number;
  pendingCandidateCount: number;
  goSources: () => void;
  goConnections: () => void;
  seedDemo: () => void;
}) {
  // Zero-facts onboarding branch: vault has no active facts yet.
  if (factCount === 0) {
    return (
      <div className="qv-tl-empty">
        <p className="qv-tl-empty__kana" aria-hidden="true">◇</p>
        <p className="qv-tl-empty__heading">
          まだ文脈が追加されていません
        </p>
        <p className="qv-tl-empty__body">
          情報を追加して承認すると、AIに渡せる文脈パックが作られます。
        </p>
        <p className="qv-tl-empty__trust">
          承認した文脈だけがAIに渡ります。保存前にMemory Inboxで確認できます。
        </p>
        <div className="qv-tl-empty__actions">
          {pendingCandidateCount > 0 ? (
            <Button variant="primary" size="sm" onClick={goSources}>
              承認待ち {pendingCandidateCount} 件を取り込みで確認
            </Button>
          ) : (
            <>
              <Button variant="primary" size="sm" onClick={goSources}>
                最初の文脈を追加
              </Button>
              <Button variant="quiet" size="sm" onClick={seedDemo}>
                デモで試す
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  // Scope-filtered branch: vault has active facts but none fall in the selected scope.
  const scopeNote = scope === "week" ? "今週" : scope === "month" ? "今月" : "";
  return (
    <div className="qv-tl-empty">
      <p className="qv-tl-empty__kana" aria-hidden="true">◇</p>
      <p className="qv-tl-empty__heading">
        {scopeNote}AIに文脈を渡した記録はまだありません
      </p>
      <p className="qv-tl-empty__body">
        AIクライアントを接続して最初のリクエストを受け取ると、ここに履歴が表示されます。
      </p>
      <div className="qv-tl-empty__actions">
        <Button variant="primary" size="sm" onClick={goConnections}>
          AIを接続する
        </Button>
        <Button variant="quiet" size="sm" onClick={goSources}>
          情報を追加する
        </Button>
      </div>
    </div>
  );
}

// ─── Summary line ─────────────────────────────────────────────────────────────

function summarize(days: TimelineDay[]): { total: number; pending: number } {
  let total = 0;
  let pending = 0;
  for (const day of days) {
    for (const entry of day.entries) {
      total += entry.facts.length;
      if (entry.disclosure === "pending") pending++;
    }
  }
  return { total, pending };
}

// ─── HomeTimeline ─────────────────────────────────────────────────────────────

const SCOPE_LABELS: Record<Scope, string> = {
  week: "今週",
  month: "今月",
  all: "すべて",
};

export function HomeTimeline({
  state,
  goSources,
  goConnections,
  seedDemo,
  onApprovePending,
  onApproveStanding,
  onRevoke,
}: HomeTimelineProps) {
  const [scope, setScope] = useState<Scope>("week");
  const days = buildActivityTimeline(state, { scope });
  const { total, pending } = summarize(days);

  const factCount = useMemo(
    () => state.facts.filter((f) => f.status === "active").length,
    [state.facts],
  );
  const pendingCandidateCount = useMemo(
    () => state.candidates.filter((c) => PENDING_STATUSES.has(c.status)).length,
    [state.candidates],
  );

  return (
    <div className="qv-tl">
      <PageHeader
        eyebrow="ホーム · アクティビティ"
        title="AIが見たあなたの文脈"
        lede="どのAIに、いつ、何を渡したか。すべてここに残ります。いつでも取り消せます。"
      />

      {/* Scope filter row */}
      <div className="qv-tl-scoperow">
        {(["week", "month", "all"] as Scope[]).map((s) => (
          <Chip
            key={s}
            label={SCOPE_LABELS[s]}
            on={scope === s}
            onClick={() => setScope(s)}
          />
        ))}
        <span className="qv-tl-scoperow__count" aria-live="polite">
          {SCOPE_LABELS[scope]}渡したFact{" "}
          <b>{total}件</b>
          {pending > 0 && (
            <>
              {" · "}承認待ち <b>{pending}件</b>
            </>
          )}
        </span>
      </div>

      {/* Timeline body */}
      {days.length === 0 ? (
        <TimelineEmpty
          scope={scope}
          factCount={factCount}
          pendingCandidateCount={pendingCandidateCount}
          goSources={goSources}
          goConnections={goConnections}
          seedDemo={seedDemo}
        />
      ) : (
        <div className="qv-tl-body">
          {days.map((day) => (
            <DaySection
              key={day.dayKey}
              day={day}
              onApprovePending={onApprovePending}
              onApproveStanding={onApproveStanding}
              onRevoke={onRevoke}
            />
          ))}
        </div>
      )}
    </div>
  );
}
