import type { ChangeEvent } from "react";

export interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export function Toggle({ id, checked, onChange, disabled = false, label }: ToggleProps) {
  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    onChange(e.target.checked);
  }

  return (
    <label className="qv-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="qv-toggle__input"
        checked={checked}
        disabled={disabled}
        onChange={handleChange}
        aria-label={label}
      />
      <span className="qv-toggle__track" aria-hidden="true">
        <span className="qv-toggle__thumb" />
      </span>
    </label>
  );
}
