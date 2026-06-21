export interface VaultStatusProps {
  label?: string;
}

export function VaultStatus({
  label = "ローカルに暗号化・鍵はこの端末のみ",
}: VaultStatusProps) {
  return (
    <div className="qv-vault-status">
      <span className="qv-vault-status__dot" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
