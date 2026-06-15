import type { SensitivityTier } from "../types";
import { sensitivityLabel } from "../vault";

export function SensitivityBadge({ sensitivity }: { sensitivity: SensitivityTier }) {
  return <span className={`badge sensitivity ${sensitivity}`}>{sensitivityLabel(sensitivity)}</span>;
}
