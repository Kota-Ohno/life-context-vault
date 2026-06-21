export interface ChipProps {
  label: string;
  on?: boolean;
  onClick?: () => void;
}

export function Chip({ label, on = false, onClick }: ChipProps) {
  return (
    <button
      type="button"
      className={["qv-chip", on && "qv-chip--on"].filter(Boolean).join(" ")}
      aria-pressed={on}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
