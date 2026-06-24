import type { SensitivityTier } from "./types";

export type SensitivityConfidence = "low" | "medium" | "high";

export interface SensitivityResult {
  tier: SensitivityTier;
  confidence: SensitivityConfidence;
  classified: boolean;
  reasons: string[];
}

const CONFIDENCE_RANK: Record<SensitivityConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function sensitivityConfidenceRank(c: SensitivityConfidence): number {
  return CONFIDENCE_RANK[c];
}

const TIER_RANK: Record<SensitivityTier, number> = {
  public: 0,
  personal: 1,
  private_consequential: 2,
  sensitive: 3,
  secret_never_send: 4,
};

function sensitivityRank(t: SensitivityTier): number {
  return TIER_RANK[t];
}

interface Signal {
  test: RegExp | ((s: string) => boolean);
  tier: SensitivityTier;
  confidence: SensitivityConfidence;
  reason: string;
}

/**
 * Luhn algorithm check for credit card numbers.
 * Accepts a string of digits only (no separators).
 */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/** Extract candidate card digits from text: 13–19 digit groups separated by spaces or hyphens. */
function containsLuhnCard(text: string): boolean {
  // Match 13-19 digit sequences optionally separated by spaces/hyphens
  const candidates = text.match(/\b\d{4}(?:[ -]\d{4}){2,4}\b|\b\d{13,19}\b/g);
  if (!candidates) return false;
  return candidates.some((raw) => {
    const digits = raw.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

// Signals ordered secret-first.
// Structured patterns (regex that matches specific formats) → "high" confidence.
// Bare keyword-group hits → "low" confidence.
// All groups ported from vault.ts detectSensitivity.
const SIGNALS: Signal[] = [
  // ── secret_never_send: credential structured patterns (high) ──
  {
    test: /\b(password|passcode|api[_\s-]?key|token|secret|private[_\s-]?key|recovery[_\s-]?code|bearer\s+[a-z0-9._-]{12,})\b\s*[:=]\s*\S+/i,
    tier: "secret_never_send",
    confidence: "high",
    reason: "matches credential assignment pattern",
  },
  // secret_never_send: national/bank ID bare keywords (low — keyword only, no value context)
  {
    test: /\b(my[_\s]?number|national[_\s]?id|bank[_\s]?account)\b/i,
    tier: "secret_never_send",
    confidence: "low",
    reason: "matches national/bank identity keyword",
  },
  // secret_never_send: Japanese identity keywords (low — bare keyword, no value context)
  {
    test: /口座番号|マイナンバー/,
    tier: "secret_never_send",
    confidence: "low",
    reason: "matches Japanese identity/account keyword",
  },
  // secret_never_send: マイナンバー 12-digit number near keyword (high — structured)
  {
    test: /マイナンバー[^\d]{0,10}\d{4}[ -]?\d{4}[ -]?\d{4}/,
    tier: "secret_never_send",
    confidence: "high",
    reason: "matches マイナンバー keyword with 12-digit number",
  },
  // secret_never_send: US SSN (high — structured NNN-NN-NNNN)
  {
    test: /\b\d{3}-\d{2}-\d{4}\b(?!-)/,
    tier: "secret_never_send",
    confidence: "high",
    reason: "matches US SSN pattern (NNN-NN-NNNN)",
  },
  // secret_never_send: credit card via Luhn check (high — structured + algorithm)
  {
    test: containsLuhnCard,
    tier: "secret_never_send",
    confidence: "high",
    reason: "matches Luhn-valid card number",
  },
  // secret_never_send: IBAN (high — structured country-code + check digits)
  {
    test: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,3}\b/,
    tier: "secret_never_send",
    confidence: "high",
    reason: "matches IBAN pattern",
  },
  // secret_never_send: bare credential keywords (low — keyword only, no value context)
  {
    test: /\b(password|passcode|api[_\s-]?key|token|secret|private[_\s-]?key|recovery[_\s-]?code)\b/i,
    tier: "secret_never_send",
    confidence: "low",
    reason: "matches credential keyword",
  },
  // secret_never_send: Japanese credential keywords (low)
  {
    test: /パスワード|秘密鍵/,
    tier: "secret_never_send",
    confidence: "low",
    reason: "matches Japanese credential keyword",
  },

  // ── sensitive: health/legal/minor keywords (low) ──
  {
    test: /\b(health|medical|doctor|diagnosis|disability|benefit|legal|minor)\b/i,
    tier: "sensitive",
    confidence: "low",
    reason: "matches health/legal/minor keyword",
  },
  // sensitive: Japanese health/legal keywords (low)
  {
    test: /病院|診断|障害|給付|法律|未成年/,
    tier: "sensitive",
    confidence: "low",
    reason: "matches Japanese health/legal keyword",
  },

  // ── private_consequential: financial/contract keywords (low) ──
  {
    test: /\b(finance|tax|pension|insurance|contract|rent|salary|payment)\b/i,
    tier: "private_consequential",
    confidence: "low",
    reason: "matches financial/contract keyword",
  },
  // private_consequential: Japanese financial/contract keywords (low)
  {
    test: /税|年金|保険|契約|家賃|給与|支払/,
    tier: "private_consequential",
    confidence: "low",
    reason: "matches Japanese financial/contract keyword",
  },

  // ── personal: email structured pattern (high) ──
  {
    test: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    tier: "personal",
    confidence: "high",
    reason: "matches email pattern",
  },
  // personal: phone number — tightened to phone-specific structures only to avoid matching
  // dates (4-2-2 / 2-2-4), IP addresses (d.d.d.d), and version strings (n.n.n).
  // Matches:
  //   (a) international prefix  +\d{1,3} followed by 7-14 digits with separators, OR
  //   (b) parenthesized area code  \(\d{3}\) followed by \d{3}[-.\s]?\d{4}, OR
  //   (c) North-American 3-3-4  \b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b
  {
    test: /(?:\+\d{1,3}[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4,}|\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b)/,
    tier: "personal",
    confidence: "high",
    reason: "matches formatted phone number",
  },
  // personal: postal address — house number + Capitalized street name + Capitalized suffix word.
  // The suffix must be Capitalized (Street/Ave/Road/etc.) to avoid matching prose like
  // "exit 23 way out", "2 court decisions", "Section 12 Road safety guide".
  {
    test: /\b\d{1,5}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct)\b/,
    tier: "personal",
    confidence: "high",
    reason: "matches postal address pattern",
  },
  // personal: Japanese postal code (high — structured 〒NNN-NNNN)
  {
    test: /〒\d{3}-\d{4}/,
    tier: "personal",
    confidence: "high",
    reason: "matches Japanese postal code",
  },
  // personal: bare contact/family keywords (low)
  {
    test: /\b(name|address|phone|email|family)\b/i,
    tier: "personal",
    confidence: "low",
    reason: "matches personal contact keyword",
  },
  // personal: Japanese contact/family keywords (low)
  {
    test: /名前|住所|電話|メール|家族/,
    tier: "personal",
    confidence: "low",
    reason: "matches Japanese personal keyword",
  },
];

export function zeroTouchEligible(
  item: {
    sensitivity?: SensitivityTier;
    sensitivityConfidence?: SensitivityConfidence;
    sensitivityClassified?: boolean;
  },
  policy: {
    requiresApprovalAbove?: SensitivityTier;
    zeroTouchConfidenceBar?: SensitivityConfidence;
  }
): boolean {
  const threshold = policy.requiresApprovalAbove ?? "personal";
  const bar = policy.zeroTouchConfidenceBar ?? "medium";
  return (
    !!item.sensitivityClassified &&
    sensitivityConfidenceRank(item.sensitivityConfidence as SensitivityConfidence) >=
      sensitivityConfidenceRank(bar) &&
    sensitivityRank(item.sensitivity as SensitivityTier) <=
      sensitivityRank(threshold)
  );
}

/**
 * Whether an item may be auto-delivered without per-request confirmation. Mirrors
 * the Rust `auto_delivery_eligible`: a user-TRUSTED (standing-delivery) connection
 * needs only the stored sensitivity tier at/below the threshold (the explicit trust
 * is the consent, and the classifier may never have run); untrusted connections
 * keep the stricter zeroTouchEligible gate (classified + confidence + tier).
 */
export function autoDeliveryEligible(
  item: {
    sensitivity?: SensitivityTier;
    sensitivityConfidence?: SensitivityConfidence;
    sensitivityClassified?: boolean;
  },
  policy: {
    requiresApprovalAbove?: SensitivityTier;
    zeroTouchConfidenceBar?: SensitivityConfidence;
  },
  trusted: boolean
): boolean {
  if (trusted) {
    const threshold = policy.requiresApprovalAbove ?? "personal";
    return sensitivityRank(item.sensitivity as SensitivityTier) <= sensitivityRank(threshold);
  }
  return zeroTouchEligible(item, policy);
}

export function classifySensitivity(text: string): SensitivityResult {
  const matched = SIGNALS.filter((s) =>
    typeof s.test === "function" ? s.test(text) : s.test.test(text)
  );
  if (matched.length === 0) {
    return { tier: "public", confidence: "low", classified: false, reasons: [] };
  }
  // Pick highest tier; among ties, pick highest confidence.
  const top = matched.reduce((a, b) => {
    const tierDiff = TIER_RANK[b.tier] - TIER_RANK[a.tier];
    if (tierDiff !== 0) return tierDiff > 0 ? b : a;
    return CONFIDENCE_RANK[b.confidence] > CONFIDENCE_RANK[a.confidence] ? b : a;
  });
  return {
    tier: top.tier,
    confidence: top.confidence,
    classified: true,
    reasons: matched.map((m) => m.reason),
  };
}
