export interface BoundaryRuleProps {
  label: string;
}

export function BoundaryRule({ label }: BoundaryRuleProps) {
  return (
    <div className="qv-boundary">
      <span>{label}</span>
      <span className="qv-boundary__line" />
    </div>
  );
}
