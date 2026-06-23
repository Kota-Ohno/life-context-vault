import type { SensitivityTier } from "./types";

// UI-only collapse of the engine's 5 sensitivity tiers into the 3 buckets the
// everyday user sees. The engine keeps all 5 tiers; this is presentation only.
export type SensitivityBucket = "public_ok" | "needs_review" | "private";

export function sensitivityBucketKey(tier: SensitivityTier): SensitivityBucket {
  switch (tier) {
    case "public":
    case "personal":
      return "public_ok";
    case "private_consequential":
    case "sensitive":
      return "needs_review";
    case "secret_never_send":
      return "private";
  }
}

const BUCKET_LABELS: Record<SensitivityBucket, string> = {
  public_ok: "公開OK",
  needs_review: "要確認",
  private: "非公開",
};

export function sensitivityBucketLabel(tier: SensitivityTier): string {
  return BUCKET_LABELS[sensitivityBucketKey(tier)];
}
