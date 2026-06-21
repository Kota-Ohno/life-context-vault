import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "quiet";
  size?: "sm" | "md";
}

export function Button({
  variant = "quiet",
  size = "md",
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    "qv-button",
    `qv-button--${variant}`,
    `qv-button--${size}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
