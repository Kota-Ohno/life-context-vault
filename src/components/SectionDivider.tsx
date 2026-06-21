export interface SectionDividerProps {
  label: string;
}

export function SectionDivider({ label }: SectionDividerProps) {
  return (
    <div className="qv-section-divider">
      <h2 className="qv-section-divider__label">{label}</h2>
      <div className="qv-section-divider__rule" />
    </div>
  );
}
