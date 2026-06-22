import { describe, it, expect } from "vitest";
import { classifySensitivity, zeroTouchEligible } from "./sensitivity";

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
