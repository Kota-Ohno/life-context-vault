/**
 * QV Component Gallery — dev-only, not imported in production nav.
 * Mount by setting SHOW_QV_GALLERY = true in App.tsx.
 *
 * Shows every base component in both light and dark themes side-by-side.
 */

import { useState } from "react";
import { Button } from "./Button";
import { Card } from "./Card";
import { Tag } from "./Tag";
import { Seal } from "./Seal";
import { BoundaryRule } from "./BoundaryRule";
import { PageHeader } from "./PageHeader";
import { SectionDivider } from "./SectionDivider";
import { SearchField } from "./SearchField";
import { VaultStatus } from "./VaultStatus";
import { Chip } from "./Chip";

function GalleryThemeFrame({
  theme,
  children,
}: {
  theme: "light" | "dark";
  children: React.ReactNode;
}) {
  return (
    <div
      data-theme={theme}
      style={{
        background: "var(--paper)",
        border: "1px solid var(--hairline-strong)",
        borderRadius: 14,
        flex: "1 1 340px",
        minWidth: 320,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          background: "var(--paper-raised)",
          borderBottom: "1px solid var(--hairline-strong)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-faint)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
        }}
      >
        {theme === "light" ? "Light" : "Dark"}
      </div>
      <div style={{ padding: 24 }}>{children}</div>
    </div>
  );
}

function ComponentSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--ink-faint)", marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function GalleryContent() {
  const [chip1, setChip1] = useState(false);
  const [chip2, setChip2] = useState(true);
  const [chip3, setChip3] = useState(false);

  return (
    <>
      {/* PageHeader */}
      <ComponentSection title="PageHeader">
        <PageHeader
          eyebrow="コンテキスト管理"
          title="金庫"
          lede="あなたの情報をコントロール。AIが受け取るのはあなたが承認した情報のみです。"
        />
      </ComponentSection>

      {/* VaultStatus */}
      <ComponentSection title="VaultStatus">
        <VaultStatus />
      </ComponentSection>

      {/* SearchField */}
      <ComponentSection title="SearchField">
        <SearchField placeholder="ファクトを検索" shortcut="⌘K" />
      </ComponentSection>

      {/* BoundaryRule */}
      <ComponentSection title="BoundaryRule">
        <BoundaryRule label="トラスト境界" />
      </ComponentSection>

      {/* SectionDivider */}
      <ComponentSection title="SectionDivider">
        <SectionDivider label="承認済みファクト" />
      </ComponentSection>

      {/* Buttons */}
      <ComponentSection title="Button">
        <div className="qv-gallery__strip">
          <Button variant="primary">承認</Button>
          <Button variant="ghost">詳細を見る</Button>
          <Button variant="quiet">キャンセル</Button>
          <Button variant="primary" size="sm">小</Button>
          <Button variant="ghost" size="sm">小</Button>
        </div>
      </ComponentSection>

      {/* Cards */}
      <ComponentSection title="Card (default + pending)">
        <div className="qv-gallery__row">
          <Card style={{ flex: "1 1 200px" }}>
            <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--ink)" }}>
              既定カード — ファクト表示などに使用
            </div>
          </Card>
          <Card tone="pending" style={{ flex: "1 1 200px" }}>
            <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--ink)" }}>
              承認待ちカード — 左端が金色
            </div>
          </Card>
        </div>
      </ComponentSection>

      {/* Tags */}
      <ComponentSection title="Tag">
        <div className="qv-gallery__strip">
          <Tag category="健康" value="高血圧" />
          <Tag category="仕事" value="Anthropic" />
          <Tag category="地域" value="東京" sealed />
          <Tag category="趣味" value="読書" sealed />
        </div>
      </ComponentSection>

      {/* Seal — the signature element */}
      <ComponentSection title="Seal (signature element)">
        <div className="qv-gallery__strip" style={{ flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
          <Seal
            variant="auto"
            label="自動で渡しました"
            detail="3分前 · Claude Desktop"
          />
          <Seal
            variant="pending"
            label="承認待ち"
            detail="ChatGPT · 2件のファクト"
          />
        </div>
      </ComponentSection>

      {/* Chips */}
      <ComponentSection title="Chip">
        <div className="qv-gallery__strip">
          <Chip label="すべて" on={chip1} onClick={() => setChip1((v) => !v)} />
          <Chip label="健康" on={chip2} onClick={() => setChip2((v) => !v)} />
          <Chip label="仕事" on={chip3} onClick={() => setChip3((v) => !v)} />
        </div>
      </ComponentSection>
    </>
  );
}

export function QVGallery({ onClose }: { onClose: () => void }) {
  return (
    <div className="qv-gallery">
      <button className="qv-gallery__back" onClick={onClose} type="button">
        ← ギャラリーを閉じる
      </button>

      <PageHeader
        eyebrow="開発者ツール"
        title="コンポーネント・ギャラリー"
        lede="Quiet Vault デザインシステム A2 — ライト／ダークの両テーマで確認"
      />

      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          marginTop: 24,
        }}
      >
        <GalleryThemeFrame theme="light">
          <GalleryContent />
        </GalleryThemeFrame>
        <GalleryThemeFrame theme="dark">
          <GalleryContent />
        </GalleryThemeFrame>
      </div>
    </div>
  );
}
