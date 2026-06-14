// Minimal i18n layer (P1-A foundation). A `t(lang, key)` lookup over the EN/JA
// catalogs with a React context so components can read the active language.
// Catalogs live in en.ts / ja.ts and are populated as UI strings are migrated.
import { createContext, useContext } from "react";
import { en } from "./en";
import { ja } from "./ja";

export type Lang = "en" | "ja";

const catalogs: Record<Lang, Record<string, string>> = { en, ja };

/** Look up a localized message. Falls back to English, then to the key. */
export function t(lang: Lang, key: string): string {
  return catalogs[lang]?.[key] ?? en[key] ?? key;
}

export const FALLBACK_LANG: Lang = "ja";

export function detectLang(): Lang {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
  }
  return FALLBACK_LANG;
}

const LangContext = createContext<Lang>(FALLBACK_LANG);

export const LangProvider = LangContext.Provider;

export function useLang(): Lang {
  return useContext(LangContext);
}
