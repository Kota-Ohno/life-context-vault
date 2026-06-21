import { Search } from "lucide-react";

export interface SearchFieldProps {
  placeholder?: string;
  shortcut?: string;
  onClick?: () => void;
}

export function SearchField({
  placeholder = "検索",
  shortcut = "⌘K",
  onClick,
}: SearchFieldProps) {
  return (
    <div
      className="qv-search"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onClick?.()}
      aria-label={`${placeholder} (${shortcut})`}
    >
      <Search size={14} aria-hidden="true" />
      <span className="qv-search__placeholder">{placeholder}</span>
      <kbd className="qv-search__kbd">{shortcut}</kbd>
    </div>
  );
}
