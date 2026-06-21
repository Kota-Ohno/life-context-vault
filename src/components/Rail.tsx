import { KeyRound, Clock, PlusCircle, ArrowLeftRight, MessageSquare, Search } from "lucide-react";
import { VaultStatus } from "./VaultStatus";
import { ThemeToggle } from "./ThemeToggle";
import { SearchField } from "./SearchField";

export type RailView =
  | "home"
  | "inbox"
  | "sources"
  | "connections"
  | "requests"
  | "search"
  | "settings";

export interface RailProps {
  view: RailView;
  setView: (v: RailView) => void;
  lang: "ja" | "en";
  setLang: (l: "ja" | "en") => void;
  /** Badge: incoming candidate count (取り込み + Inbox) */
  candidateCount: number;
  /** Badge: requests needing action */
  requestCount: number;
  /** Badge: reviewable facts count (Search secondary) */
  reviewFactCount: number;
  /** True if any connector is "connected" */
  hasActiveConnection: boolean;
}

export function Rail({
  view,
  setView,
  lang,
  setLang,
  candidateCount,
  requestCount,
  reviewFactCount,
  hasActiveConnection,
}: RailProps) {
  return (
    <aside className="qv-rail" aria-label="ナビゲーション">
      {/* Brand */}
      <div className="qv-rail__brand">
        <div className="qv-rail__brand-mark" aria-hidden="true">
          <KeyRound size={16} strokeWidth={2} />
        </div>
        <div className="qv-rail__brand-text">
          <strong>Life Context Vault</strong>
          <span>あなたの中に留める</span>
        </div>
      </div>

      {/* Search */}
      <SearchField onClick={() => setView("search")} />

      {/* Primary pillars */}
      <nav className="qv-rail__nav" aria-label="主導線">
        <RailPillar
          icon={<Clock size={16} />}
          label="文脈"
          active={view === "home"}
          onClick={() => setView("home")}
        />
        <RailPillar
          icon={<PlusCircle size={16} />}
          label="取り込み"
          active={view === "sources"}
          badge={candidateCount || undefined}
          onClick={() => setView("sources")}
        />
        <RailPillar
          icon={<ArrowLeftRight size={16} />}
          label="接続"
          active={view === "connections"}
          hasMarker={hasActiveConnection}
          onClick={() => setView("connections")}
        />
      </nav>

      {/* Secondary group */}
      <div className="qv-rail__secondary" role="navigation" aria-label="その他">
        <div className="qv-rail__secondary-label">その他</div>
        <RailSecondary
          icon={<MessageSquare size={14} />}
          label="依頼"
          active={view === "requests"}
          badge={requestCount || undefined}
          onClick={() => setView("requests")}
        />
        <RailSecondary
          icon={<Search size={14} />}
          label="検索"
          active={view === "search"}
          badge={reviewFactCount || undefined}
          onClick={() => setView("search")}
        />
      </div>

      {/* Foot */}
      <div className="qv-rail__foot">
        <VaultStatus />
        <div className="qv-rail__foot-row">
          <ThemeToggle />
          <button
            className="qv-rail__settings-btn"
            type="button"
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => setView("settings")}
          >
            ⚙ 設定
          </button>
          <button
            className="qv-rail__lang-btn"
            type="button"
            onClick={() => setLang(lang === "ja" ? "en" : "ja")}
            aria-label="Toggle language"
            title={lang === "ja" ? "Switch to English" : "日本語に切り替え"}
          >
            {lang.toUpperCase()}
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ── Internal sub-components ─────────────────────────────────────── */

interface RailPillarProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  hasMarker?: boolean;
}

function RailPillar({ icon, label, active, onClick, badge, hasMarker }: RailPillarProps) {
  return (
    <button
      type="button"
      className={`qv-rail__pillar${active ? " qv-rail__pillar--active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span className="qv-rail__pillar-icon" aria-hidden="true">{icon}</span>
      <span className="qv-rail__pillar-label">{label}</span>
      {hasMarker && <span className="qv-rail__dot" aria-label="接続中" />}
      {badge ? <strong className="qv-rail__badge">{badge}</strong> : null}
    </button>
  );
}

interface RailSecondaryProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}

function RailSecondary({ icon, label, active, onClick, badge }: RailSecondaryProps) {
  return (
    <button
      type="button"
      className={`qv-rail__secondary-item${active ? " qv-rail__secondary-item--active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {badge ? <strong className="qv-rail__badge qv-rail__badge--sm">{badge}</strong> : null}
    </button>
  );
}
