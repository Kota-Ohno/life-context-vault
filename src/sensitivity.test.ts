import { describe, it, expect } from "vitest";
import { classifySensitivity, zeroTouchEligible, luhnValid } from "./sensitivity";

describe("classifySensitivity", () => {
  it("no signal ⇒ unclassified, public, low (never default-public-classified)", () => {
    const r = classifySensitivity("favorite coffee is a flat white");
    expect(r.classified).toBe(false);
    expect(r.tier).toBe("public");
    expect(r.confidence).toBe("low");
  });

  it("email ⇒ personal, HIGH, with reason", () => {
    const r = classifySensitivity("reach me at alice@example.com");
    expect(r.classified).toBe(true);
    expect(r.tier).toBe("personal");
    expect(r.confidence).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/email/i);
  });

  it("credential ⇒ secret_never_send (never zero-touch), preserving secret-first priority", () => {
    const r = classifySensitivity("my password is hunter2 and AWS_SECRET_ACCESS_KEY=abc");
    expect(r.tier).toBe("secret_never_send");
    expect(r.classified).toBe(true);
  });

  it("bare keyword hit ⇒ classifies tier but LOW confidence (below default bar)", () => {
    // a plain keyword like "contract" with no structured pattern
    const r = classifySensitivity("we discussed the contract yesterday");
    expect(r.confidence).toBe("low"); // tier may be set, but low ⇒ zero-touch ineligible at medium bar
  });
});

describe("luhnValid", () => {
  it("Luhn-valid card number ⇒ true", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
  });
  it("Luhn-invalid digit run ⇒ false", () => {
    expect(luhnValid("1234567890123456")).toBe(false);
  });
});

describe("structured entity detectors", () => {
  // ── phone ──
  it("phone: formatted US number ⇒ personal/high", () => {
    const r = classifySensitivity("+1 (415) 555-0132");
    expect(r.tier).toBe("personal");
    expect(r.confidence).toBe("high");
  });
  it("phone FP: bare 8-digit sales figure ⇒ NOT phone (tier != personal via high)", () => {
    const r = classifySensitivity("in 2024 we sold 12345678 units");
    // must not be classified as personal/high via phone detector
    expect(r.confidence === "high" && r.tier === "personal").toBe(false);
  });

  // ── SSN ──
  it("SSN: standard format ⇒ secret_never_send/high", () => {
    const r = classifySensitivity("SSN 123-45-6789");
    expect(r.tier).toBe("secret_never_send");
    expect(r.confidence).toBe("high");
  });
  it("SSN FP: order number with wrong shape ⇒ not SSN", () => {
    const r = classifySensitivity("order 123-45-6789-00");
    // the extra -00 suffix means it should not be secret_never_send via SSN pattern
    // (it may still match keyword patterns at low confidence)
    expect(r.confidence === "high" && r.tier === "secret_never_send").toBe(false);
  });

  // ── credit card ──
  it("card: Luhn-valid card ⇒ secret_never_send/high", () => {
    const r = classifySensitivity("card 4111 1111 1111 1111");
    expect(r.tier).toBe("secret_never_send");
    expect(r.confidence).toBe("high");
  });
  it("card FP: Luhn-invalid 16-digit run ⇒ NOT card", () => {
    const r = classifySensitivity("1234 5678 9012 3456");
    expect(r.confidence === "high" && r.tier === "secret_never_send").toBe(false);
  });

  // ── IBAN ──
  it("IBAN: German IBAN ⇒ secret_never_send/high", () => {
    const r = classifySensitivity("DE89 3704 0044 0532 0130 00");
    expect(r.tier).toBe("secret_never_send");
    expect(r.confidence).toBe("high");
  });
  it("IBAN FP: random alnum run ⇒ not IBAN", () => {
    const r = classifySensitivity("ref code XY12ABCD5678EFGH");
    expect(r.confidence === "high" && r.tier === "secret_never_send").toBe(false);
  });

  // ── マイナンバー ──
  it("マイナンバー number: keyword + 12-digit grouped ⇒ secret_never_send/high", () => {
    const r = classifySensitivity("マイナンバーは 1234 5678 9012");
    expect(r.tier).toBe("secret_never_send");
    expect(r.confidence).toBe("high");
  });

  // ── postal address ──
  it("address: house number + street suffix ⇒ personal/high", () => {
    const r = classifySensitivity("123 Main Street, Springfield");
    expect(r.tier).toBe("personal");
    expect(r.confidence).toBe("high");
  });
  it("address FP: chapter heading ⇒ NOT address", () => {
    const r = classifySensitivity("Chapter 123 main idea");
    expect(r.confidence === "high" && r.tier === "personal").toBe(false);
  });
});

describe("zeroTouchEligible", () => {
  it("unclassified item ⇒ false (even if nominal tier is public)", () => {
    expect(
      zeroTouchEligible(
        { sensitivity: "public", sensitivityConfidence: "high", sensitivityClassified: false },
        {}
      )
    ).toBe(false);
  });

  it("classified + confidence below bar ⇒ false", () => {
    expect(
      zeroTouchEligible(
        { sensitivity: "personal", sensitivityConfidence: "low", sensitivityClassified: true },
        { zeroTouchConfidenceBar: "medium" }
      )
    ).toBe(false);
  });

  it("classified + confidence >= bar + rank <= threshold ⇒ true", () => {
    expect(
      zeroTouchEligible(
        { sensitivity: "personal", sensitivityConfidence: "high", sensitivityClassified: true },
        { requiresApprovalAbove: "personal", zeroTouchConfidenceBar: "medium" }
      )
    ).toBe(true);
  });

  it("classified + rank > threshold ⇒ false", () => {
    expect(
      zeroTouchEligible(
        { sensitivity: "private_consequential", sensitivityConfidence: "high", sensitivityClassified: true },
        { requiresApprovalAbove: "personal", zeroTouchConfidenceBar: "medium" }
      )
    ).toBe(false);
  });

  it("missing fields (undefined) ⇒ false (no throw)", () => {
    expect(() =>
      zeroTouchEligible({}, {})
    ).not.toThrow();
    expect(zeroTouchEligible({}, {})).toBe(false);
  });
});
