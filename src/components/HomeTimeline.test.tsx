/**
 * HomeTimeline – TimelineEmpty zero-facts onboarding branch (task D1).
 *
 * These tests verify that when the vault has no approved facts the empty state
 * shows context-appropriate CTAs that both route through goSources:
 *   1. Zero facts + zero pending candidates  → "最初の文脈を追加" primary CTA
 *   2. Zero facts + N pending candidates     → "承認待ち N 件" primary CTA
 *   3. Zero facts + only non-pending cands   → "最初の文脈を追加" primary CTA (no pending count)
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createEmptyVault } from "../vault";
import type { MemoryCandidate, VaultState } from "../types";
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

/** Render HomeTimeline and return the HTML string. */
function renderTimeline(
  state: VaultState,
  {
    goSources = vi.fn(),
    goConnections = vi.fn(),
  }: { goSources?: () => void; goConnections?: () => void } = {},
): string {
  return renderToStaticMarkup(
    createElement(HomeTimeline, { state, goSources, goConnections }),
  );
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("HomeTimeline – zero-facts onboarding empty state (D1)", () => {
  it("shows '最初の文脈を追加' CTA when vault has no facts and no pending candidates", () => {
    const state = createEmptyVault(); // facts: [], candidates: []
    const html = renderTimeline(state);

    expect(html).toContain("最初の文脈を追加");
    // The scope-based "record not found" heading must NOT appear for zero-facts vault
    expect(html).not.toContain("AIに文脈を渡した記録はまだありません");
  });

  it("shows '承認待ち N 件' CTA when vault has no facts but has pending candidates", () => {
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
});
