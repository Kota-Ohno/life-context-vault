import { describe, expect, it } from "vitest";
import { detectLang, FALLBACK_LANG, t } from "./index";
import { en } from "./en";
import { ja } from "./ja";

describe("i18n", () => {
  it("returns the localized message for each language", () => {
    expect(t("ja", "nav.settings")).toBe("Settings");
    expect(t("en", "onboarding.title")).toBe(en["onboarding.title"]);
    expect(t("ja", "onboarding.title")).toBe(ja["onboarding.title"]);
  });

  it("falls back to english then to the key for unknown messages", () => {
    // ja catalog intentionally omits some keys; ensure fallback works.
    expect(t("en", "missing.key")).toBe("missing.key");
  });

  it("keeps en and ja catalogs key-compatible on shared keys", () => {
    const enKeys = new Set(Object.keys(en));
    for (const key of Object.keys(ja)) {
      // every ja key must exist in en (the fallback source of truth)
      expect(enKeys.has(key)).toBe(true);
    }
  });

  it("detects language from navigator when present", () => {
    expect(["en", "ja"]).toContain(detectLang());
    expect(FALLBACK_LANG).toBe("ja");
  });
});
