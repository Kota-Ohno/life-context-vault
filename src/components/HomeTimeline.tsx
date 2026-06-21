import { useState } from "react";
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

const SENSITIVITY_LABELS: Record<string, string> = {
  public:                  "public",
  personal:                "personal",
  private_consequential:   "private_consequential",
  sensitive:               "sensitive",
  secret_never_send:       "secret_never_send",
};

function sensitivityShort(s: string): string {
  return SENSITIVITY_LABELS[s] ?? s;
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
  const glyph = clientGlyph(entry.clientId, entry.clientName);

  const boundaryLabel = isPending ? "承認すると渡る内容" : "AIに渡った内容";
  const sealVariant = isPending ? "pending" : "auto";
  const sealLabel = isPending ? "あなたの承認待ち" : "自動で渡しました";
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

      {/* Entry footer */}
      <div className="qv-tl-entry-foot">
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

function TimelineEmpty({
  scope,
  goSources,
  goConnections,
}: {
  scope: Scope;
  goSources: () => void;
  goConnections: () => void;
}) {
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
  onApprovePending,
  onApproveStanding,
  onRevoke,
}: HomeTimelineProps) {
  const [scope, setScope] = useState<Scope>("week");
  const days = buildActivityTimeline(state, { scope });
  const { total, pending } = summarize(days);

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
        <TimelineEmpty scope={scope} goSources={goSources} goConnections={goConnections} />
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
