/**
 * batchApproval.test.ts — Tests for isBatchEligible helper.
 *
 * These tests enforce the trust-boundary invariants for batch approval:
 * blocked_sensitive and secret_never_send candidates must never be eligible.
 */

import { describe, it, expect } from "vitest";
import { isBatchEligible } from "./batchApproval";
import type { MemoryCandidate } from "./types";

function makeCandidate(
  overrides: Partial<MemoryCandidate>
): MemoryCandidate {
  return {
    id: "cand_test",
    sourceIds: ["src_test"],
    proposedFactText: "Test fact",
    reasonToRemember: "For testing",
    domain: "general",
    detectedSensitivity: "personal",
    status: "new",
    conflictReason: null,
    conflictingFactIds: [],
    createdAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as MemoryCandidate;
}

describe("isBatchEligible", () => {
  it("returns true for a normal pending candidate", () => {
    expect(isBatchEligible(makeCandidate({ status: "new", detectedSensitivity: "personal" }))).toBe(true);
  });

  it("returns false for needs_user_detail status (detail prompt is per-item only)", () => {
    expect(isBatchEligible(makeCandidate({ status: "needs_user_detail" }))).toBe(false);
  });

  it("returns false for blocked_sensitive status — must not be batch-approvable", () => {
    expect(isBatchEligible(makeCandidate({ status: "blocked_sensitive" }))).toBe(false);
  });

  it("returns false for secret_never_send sensitivity — the engine would reject it anyway", () => {
    expect(
      isBatchEligible(
        makeCandidate({ status: "new", detectedSensitivity: "secret_never_send" })
      )
    ).toBe(false);
  });

  it("returns false for already-approved candidates", () => {
    expect(isBatchEligible(makeCandidate({ status: "approved" }))).toBe(false);
    expect(isBatchEligible(makeCandidate({ status: "edited_and_approved" }))).toBe(false);
  });

  it("returns false for rejected / archived candidates", () => {
    expect(isBatchEligible(makeCandidate({ status: "rejected" }))).toBe(false);
    expect(isBatchEligible(makeCandidate({ status: "archived" }))).toBe(false);
  });
});
