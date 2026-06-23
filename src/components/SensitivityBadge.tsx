import type { SensitivityTier } from "../types";
import { sensitivityLabel } from "../vault";
import { sensitivityBucketKey, sensitivityBucketLabel } from "../sensitivityBuckets";

// Everyday UI shows the 3-bucket label. The raw 5-tier label rides along as a
// mouse-hover `title` hint only — it is NOT the 「詳細」 disclosure (a native title
// is not keyboard- or screen-reader-reachable). The accessible raw-tier disclosure
// is the Fact detail row's <DetailsDisclosure> in App.tsx; the 3-bucket label here
// is sufficient on its own for the everyday decision.
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
