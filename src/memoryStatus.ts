import type { CandidateStatus, FactStatus } from "./types";

export type MemoryStatus =
  | { type: "candidate"; status: CandidateStatus }
  | { type: "fact"; status: FactStatus };

export const candidateMemoryStatus = (status: CandidateStatus): MemoryStatus => ({
  type: "candidate",
  status,
});

export const factMemoryStatus = (status: FactStatus): MemoryStatus => ({
  type: "fact",
  status,
});

export const memoryStatusLabel = (status: MemoryStatus): string => {
  if (status.type === "candidate") {
    switch (status.status) {
      case "new":
      case "needs_user_detail":
        return "確認待ち";
      case "approved":
      case "edited_and_approved":
        return "承認済み";
      case "blocked_sensitive":
        return "非公開";
      case "rejected":
      case "archived":
        // These are not explicitly required by the test, but map logically
        return "却下";
      default:
        const _exhaustive: never = status.status;
        return _exhaustive;
    }
  } else {
    switch (status.status) {
      case "active":
        return "承認済み";
      case "needs_review":
        return "確認待ち";
      case "superseded":
        return "置き換え済み";
      case "expired":
        return "期限切れ";
      case "user_hidden":
        return "非表示";
      case "deleted":
        return "削除済み";
      default:
        const _exhaustive: never = status.status;
        return _exhaustive;
    }
  }
};
