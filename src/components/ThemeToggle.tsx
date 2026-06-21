import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "light" | "dark";

function resolveInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem("lcv-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("lcv-theme", theme);
  } catch {
    // localStorage unavailable
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);

  // Apply on mount and whenever theme changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  function toggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={theme === "dark" ? "ライトモードに切替" : "ダークモードに切替"}
      title={theme === "dark" ? "ライトモード" : "ダークモード"}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      <span>表示</span>
    </button>
  );
}
