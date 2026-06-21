import type { HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: "default" | "pending";
  as?: "div" | "article" | "section";
}

export function Card({
  tone = "default",
  as: Tag = "div",
  className,
  children,
  ...rest
}: CardProps) {
  const cls = [
    "qv-card",
    tone === "pending" && "qv-card--pending",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={cls} {...(rest as HTMLAttributes<HTMLElement>)}>
      {children}
    </Tag>
  );
}
