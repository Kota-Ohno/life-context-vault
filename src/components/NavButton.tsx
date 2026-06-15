export function NavButton({
  icon,
  label,
  ariaLabel,
  active,
  onClick,
  badge
}: {
  icon: React.ReactNode;
  label: string;
  ariaLabel?: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      aria-label={ariaLabel ?? label}
      aria-current={active ? "page" : undefined}
      className={active ? "nav-item active" : "nav-item"}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
      {badge ? <strong>{badge}</strong> : null}
    </button>
  );
}

