import type { ReactNode } from "react";

export interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  lede?: ReactNode;
}

export function PageHeader({ eyebrow, title, lede }: PageHeaderProps) {
  return (
    <header className="qv-page-header">
      {eyebrow && <p className="qv-page-header__eyebrow">{eyebrow}</p>}
      <h1 className="qv-page-header__title">{title}</h1>
      {lede && <p className="qv-page-header__lede">{lede}</p>}
    </header>
  );
}
