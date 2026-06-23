/**
 * batchApproval.ts — Pure helpers for batch candidate approval.
 *
 * No IPC, no boundary logic here. The actual approval still routes through
 * the existing per-item `approve(candidate)` handler in App.tsx, which calls
 * `approveCandidate` in vault.ts and hard-rejects secret_never_send.
 */

import type { MemoryCandidate, SensitivityTier } from "./types";

/**
 * Sensitivity tiers that must NEVER be batch-selected.
 * `secret_never_send` (tier 4) cannot become an ApprovedFact by design;
 * `blocked_sensitive` candidates must go through individual review.
 */
const INELIGIBLE_TIERS: ReadonlySet<SensitivityTier> = new Set<SensitivityTier>([
  "secret_never_send",
]);

/**
 * Returns true iff a candidate may be included in a batch approval selection.
 *
 * Rules (non-negotiable — the reviewer will check these):
 *  - status must be "new" or "needs_user_detail" (pending review)
 *  - status must NOT be "blocked_sensitive" (requires explicit individual review)
 *  - detectedSensitivity must NOT be "secret_never_send" (the engine would reject it anyway)
 */
export function isBatchEligible(candidate: MemoryCandidate): boolean {
  if (candidate.status === "blocked_sensitive") return false;
  if (INELIGIBLE_TIERS.has(candidate.detectedSensitivity)) return false;
  // Only pending-review candidates make sense to batch-approve
  if (candidate.status !== "new" && candidate.status !== "needs_user_detail") return false;
  return true;
}
