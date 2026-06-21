export interface SealProps {
  variant: "auto" | "pending";
  label: string;
  detail: string;
}

export function Seal({ variant, label, detail }: SealProps) {
  return (
    <span className="qv-seal">
      <span className={["qv-seal__stamp", variant === "auto" && "qv-seal__stamp--pine"].filter(Boolean).join(" ")}>
        {variant === "auto" ? "✓" : "!"}
      </span>
      <span className="qv-seal__txt">
        <b>{label}</b>
        <small>{detail}</small>
      </span>
    </span>
  );
}
