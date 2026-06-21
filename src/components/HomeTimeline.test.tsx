/**
 * HomeTimeline – TimelineEmpty zero-facts onboarding branch (task D1).
 *
 * These tests verify that when the vault has no approved facts the empty state
 * shows context-appropriate CTAs that both route through goSources:
 *   1. Zero facts + zero pending candidates  → "最初の文脈を追加" primary CTA + "デモで試す" secondary + trust line
 *   2. Zero facts + N pending candidates     → "承認待ち N 件を取り込みで確認" primary CTA
 *   3. Zero facts + only non-pending cands   → "最初の文脈を追加" primary CTA (no pending count)
 *   c. ≥1 ACTIVE fact + no timeline entries  → scope-empty message; no onboarding CTA
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createEmptyVault } from "../vault";
import type { ApprovedFact, MemoryCandidate, VaultState } from "../types";
import { HomeTimeline } from "./HomeTimeline";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal MemoryCandidate with the given status. */
function makeCandidate(
  id: string,
  status: MemoryCandidate["status"],
): MemoryCandidate {
  return {
    id,
    sourceIds: ["src_test"],
    proposedFactText: "test candidate",
    domain: "identity_and_profile",
    candidateType: "note",
    detectedSensitivity: "public",
    confidence: "medium",
    reasonToRemember: "test",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    createsFactIds: [],
    conflictWithFactIds: [],
  };
}

/** Build a minimal ApprovedFact with the given status. */
function makeFact(
  id: string,
  status: ApprovedFact["status"] = "active",
): ApprovedFact {
  return {
    id,
    factText: "test fact",
    domain: "identity_and_profile",
    factType: "note",
    sourceIds: [],
    sensitivity: "public",
    confidence: "user_asserted",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    approvedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    supersedesFactIds: [],
  };
}

/** Render HomeTimeline and return the HTML string. */
function renderTimeline(
  state: VaultState,
  {
    goSources = vi.fn(),
    goConnections = vi.fn(),
    seedDemo = vi.fn(),
  }: { goSources?: () => void; goConnections?: () => void; seedDemo?: () => void } = {},
): string {
  return renderToStaticMarkup(
    createElement(HomeTimeline, { state, goSources, goConnections, seedDemo }),
  );
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("HomeTimeline – zero-facts onboarding empty state (D1)", () => {
  it("(a) shows '最初の文脈を追加' primary CTA, 'デモで試す' secondary CTA, and trust line when vault has no facts and no pending candidates", () => {
    const state = createEmptyVault(); // facts: [], candidates: []
    const html = renderTimeline(state);

    // Primary CTA present
    expect(html).toContain("最初の文脈を追加");
    // Secondary demo button present
    expect(html).toContain("デモで試す");
    // Trust line present
    expect(html).toContain("承認した文脈だけがAIに渡ります");
    // The scope-based "record not found" heading must NOT appear for zero-facts vault
    expect(html).not.toContain("AIに文脈を渡した記録はまだありません");
  });

  it("shows '承認待ち N 件を取り込みで確認' CTA when vault has no facts but has pending candidates", () => {
    const state: VaultState = {
      ...createEmptyVault(),
      candidates: [
        makeCandidate("cand_1", "new"),
        makeCandidate("cand_2", "needs_user_detail"),
        makeCandidate("cand_3", "blocked_sensitive"),
      ],
    };
    const html = renderTimeline(state);

    expect(html).toContain("承認待ち");
    expect(html).toContain("3");
    expect(html).toContain("取り込みで確認");
    // The "add first context" CTA must NOT appear when pending items exist
    expect(html).not.toContain("最初の文脈を追加");
  });

  it("shows '最初の文脈を追加' CTA when vault has no facts and candidates are all non-pending", () => {
    const state: VaultState = {
      ...createEmptyVault(),
      candidates: [
        makeCandidate("cand_a", "approved"),
        makeCandidate("cand_b", "rejected"),
        makeCandidate("cand_c", "archived"),
      ],
    };
    const html = renderTimeline(state);

    expect(html).toContain("最初の文脈を追加");
    expect(html).not.toContain("承認待ち");
  });

  it("(c) shows scope-empty message and no onboarding CTA when vault has ≥1 active fact but no timeline entries in scope", () => {
    // One active fact — vault is NOT first-run, but no context packs exist so
    // the timeline is empty for the default 'week' scope.
    const state: VaultState = {
      ...createEmptyVault(),
      facts: [makeFact("fact_1", "active")],
    };
    const html = renderTimeline(state);

    // Scope-empty heading must appear
    expect(html).toContain("AIに文脈を渡した記録はまだありません");
    // Onboarding CTA must NOT appear
    expect(html).not.toContain("最初の文脈を追加");
    // Demo button must NOT appear
    expect(html).not.toContain("デモで試す");
  });

  it("still shows onboarding when vault has only superseded facts (superseded ≠ active)", () => {
    const state: VaultState = {
      ...createEmptyVault(),
      facts: [makeFact("fact_s", "superseded")],
    };
    const html = renderTimeline(state);

    // superseded facts don't count → first-run onboarding must still appear
    expect(html).toContain("まだ文脈が追加されていません");
    expect(html).toContain("最初の文脈を追加");
    expect(html).not.toContain("AIに文脈を渡した記録はまだありません");
  });
});
