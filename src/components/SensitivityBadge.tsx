import type { SensitivityTier } from "../types";
import { sensitivityLabel } from "../vault";
import { sensitivityBucketKey, sensitivityBucketLabel } from "../sensitivityBuckets";

// Everyday UI shows the 3-bucket label; the raw 5-tier label stays reachable
// via the native tooltip (title) as the minimal 「詳細」 affordance.
export function SensitivityBadge({ sensitivity }: { sensitivity: SensitivityTier }) {
  return (
    <span
      className={`badge sensitivity bucket-${sensitivityBucketKey(sensitivity)}`}
      title={sensitivityLabel(sensitivity)}
    >
      {sensitivityBucketLabel(sensitivity)}
    </span>
  );
}
