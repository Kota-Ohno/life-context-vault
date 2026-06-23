// src/components/DetailsDisclosure.tsx
import type { ReactNode } from "react";

// Native <details> disclosure for power-user / debugging values (raw tier,
// confidence, approval mode, per-client bar). Hidden by default; no JS state.
export function DetailsDisclosure({
  summary = "詳細",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="qv-details">
      <summary className="qv-details__summary">{summary}</summary>
      <div className="qv-details__body">{children}</div>
    </details>
  );
}
