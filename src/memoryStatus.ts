import type { CandidateStatus, FactStatus } from "./types";

// UI-only unification: candidate and Fact are one "記憶" concept to the user,
// distinguished by a status chip. The engine keeps them as separate entities.
export type MemoryStatusKey =
  | "pending"
  | "approved"
  | "blocked"
  | "superseded"
  | "expired"
  | "hidden"
  | "removed"
  | "rejected";

export function candidateMemoryStatus(s: CandidateStatus): MemoryStatusKey {
  switch (s) {
    case "new":
    case "needs_user_detail":
      return "pending";
    case "approved":
    case "edited_and_approved":
      return "approved";
    case "blocked_sensitive":
      return "blocked";
    case "rejected":
      return "rejected";
    case "archived":
      return "removed";
  }
}

export function factMemoryStatus(s: FactStatus): MemoryStatusKey {
  switch (s) {
    case "active":
      return "approved";
    case "needs_review":
      return "pending";
    case "superseded":
      return "superseded";
    case "expired":
      return "expired";
    case "user_hidden":
      return "hidden";
    case "deleted":
      return "removed";
  }
}

const STATUS_LABELS: Record<MemoryStatusKey, string> = {
  pending: "確認待ち",
  approved: "承認済み",
  // "対象外" (set aside), deliberately NOT "非公開": a blocked_sensitive candidate can
  // carry a `sensitive` tier (bucket 要確認) as well as `secret_never_send` (bucket 非公開,
  // sensitivityBuckets.ts), so reusing 非公開 here would contradict the badge on the same
  // card. 非公開 stays reserved for the secret sensitivity bucket + its exclusion reason.
  blocked: "対象外",
  superseded: "置き換え済み",
  expired: "期限切れ",
  hidden: "非表示",
  removed: "削除済み",
  rejected: "却下",
};

export function memoryStatusLabel(key: MemoryStatusKey): string {
  return STATUS_LABELS[key];
}
