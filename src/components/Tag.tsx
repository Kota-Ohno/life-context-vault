export interface TagProps {
  category: string;
  value: string;
  sealed?: boolean;
}

export function Tag({ category, value, sealed = false }: TagProps) {
  return (
    <span className={["qv-tag", sealed && "qv-tag--sealed"].filter(Boolean).join(" ")}>
      <span className="qv-tag__cat">{category}</span>
      {value}
    </span>
  );
}
