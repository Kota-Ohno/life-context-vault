# Fail-safe Sensitivity Classification & Allowlist Zero-touch Gate (P0 core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zero-touch delivery fail-safe — a Context Pack item auto-delivers only with *positive* evidence of low sensitivity at sufficient confidence; unknown/low-confidence content falls to review.

**Architecture:** Replace the keyword-only, default-`public`, fail-open sensitivity detection (TS `detectSensitivity` and Rust `detect_sensitivity`) with a classifier returning `{tier, confidence, classified, reasons}` that never defaults to `public` on no signal (it returns `classified:false`). Carry `sensitivityClassified` + `sensitivityConfidence` through candidate → fact → pack item. Change the zero-touch gate from denylist (`rank ≤ threshold`) to allowlist (`classified ∧ confidence ≥ bar ∧ rank ≤ threshold`). Migrate existing data as `unclassified` (safe), with a local one-shot reclassify.

**Tech Stack:** React 19 + TypeScript + Vite (`src/`), Rust (synchronous, `std::sync::Mutex`) in `src-tauri/src/lib.rs`. Vitest for TS; `#[cfg(test)] mod tests` for Rust.

**Source of truth:** `docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md` (decisions 3, 8, 9, 10; §5).

## Global Constraints

- **Dual core:** `src/vault.ts` (TS core; browser/test path) and `src-tauri/src/lib.rs` `*_at_path` (Rust core; native path) BOTH carry classification + gate logic and MUST stay behaviorally consistent. Every behavior change lands in both, with mirrored tests.
- **Trust boundary is the product.** This change is boundary-relevant: extend `src/vault.test.ts` AND the Rust `mod tests`, and run `npm run product:check` before declaring done.
- **IPC casing:** Rust structs `#[serde(rename_all = "camelCase")]`; persisted `vault_state` JSON is TS-shaped camelCase. New fields are camelCase on the wire.
- **Never default to `public` on absent signal.** No-signal ⇒ `{ tier: "public", confidence: "low", classified: false }`. `classified:false` is what makes it zero-touch-ineligible; the nominal tier stays `public` only for display/rank.
- **Do NOT run `cargo fmt`** (2-space tree, no rustfmt.toml — see R3, separate). Match surrounding style by hand.
- **Existing `confidence` fields are NOT sensitivity confidence.** `MemoryCandidate.confidence` / `ApprovedFact.confidence` are extraction/provenance confidence — DO NOT overload them. Add new `sensitivityConfidence` + `sensitivityClassified`.
- **SensitivityTier order (rank):** `public(0) < personal(1) < private_consequential(2) < sensitive(3) < secret_never_send(4)` (`src/types.ts:1`).
- **Confidence enum & bar:** `"low" | "medium" | "high"`; default zero-touch bar = `"medium"` (low ⇒ review).

---

## File Structure

- `src/sensitivity.ts` — **new.** The TS classifier: `classifySensitivity(text) → SensitivityResult`, the result/confidence types, `sensitivityConfidenceRank`, and `zeroTouchEligible(item, policy)`. Extracted so both `vault.ts` and tests import one source. Contains the keyword/signal logic moved out of `vault.ts:detectSensitivity`.
- `src/sensitivity.test.ts` — **new.** Unit tests for the classifier + gate predicate.
- `src/types.ts` — **modify.** Add `sensitivityConfidence`/`sensitivityClassified` to `MemoryCandidate`, `MemoryProposal`, `ApprovedFact`, `ContextPackItem`; add `zeroTouchConfidenceBar?` to the access-policy type.
- `src/vault.ts` — **modify.** Replace `detectSensitivity` callers to use `classifySensitivity`; populate the new fields on extract/approve/pack-build; apply `zeroTouchEligible` where delivery eligibility is decided; migration normalization on load.
- `src/vault.test.ts` — **modify.** Boundary tests for the new gate + migration.
- `src-tauri/src/lib.rs` — **modify.** Mirror: `SensitivityResult` struct + `classify_sensitivity`; carry fields onto candidate/fact/pack-item JSON; allowlist gate at the `requires_confirmation` site (`~1284`); migration normalization in the load/normalize path; Rust `mod tests`.

---

## Task 1: TS classifier contract + types (`src/sensitivity.ts`)

**Files:**
- Create: `src/sensitivity.ts`
- Create: `src/sensitivity.test.ts`
- Modify: `src/types.ts` (export `SensitivityTier` is already there; no change needed here)

**Interfaces:**
- Produces: `SensitivityConfidence = "low"|"medium"|"high"`; `SensitivityResult = { tier: SensitivityTier; confidence: SensitivityConfidence; classified: boolean; reasons: string[] }`; `classifySensitivity(text: string): SensitivityResult`; `sensitivityConfidenceRank(c): number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/sensitivity.test.ts
import { describe, it, expect } from "vitest";
import { classifySensitivity } from "./sensitivity";

describe("classifySensitivity", () => {
  it("returns classified:false (unclassified) for content with no sensitivity signal", () => {
    const r = classifySensitivity("favorite coffee is a flat white");
    expect(r.classified).toBe(false);
    expect(r.tier).toBe("public");
    expect(r.confidence).toBe("low");
  });

  it("classifies an email address as personal with a reason, high confidence", () => {
    const r = classifySensitivity("reach me at alice@example.com");
    expect(r.classified).toBe(true);
    expect(r.tier).toBe("personal");
    expect(r.confidence).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/email/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sensitivity.test.ts`
Expected: FAIL — cannot find module `./sensitivity`.

- [ ] **Step 3: Write minimal implementation**

Port the existing keyword/regex logic from `src/vault.ts:detectSensitivity` (vault.ts:~2482) into signal rules here, but return the richer result and **never default to public-classified**. Start with the email signal to make the test pass; keep existing keyword groups as additional rules.

```ts
// src/sensitivity.ts
import type { SensitivityTier } from "./types";

export type SensitivityConfidence = "low" | "medium" | "high";

export interface SensitivityResult {
  tier: SensitivityTier;
  confidence: SensitivityConfidence;
  classified: boolean;
  reasons: string[];
}

const CONFIDENCE_RANK: Record<SensitivityConfidence, number> = { low: 0, medium: 1, high: 2 };
export function sensitivityConfidenceRank(c: SensitivityConfidence): number { return CONFIDENCE_RANK[c]; }

interface Signal { test: RegExp; tier: SensitivityTier; confidence: SensitivityConfidence; reason: string; }

const SIGNALS: Signal[] = [
  { test: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, tier: "personal", confidence: "high", reason: "matches email pattern" },
  // NOTE: port the remaining keyword groups currently in vault.ts:detectSensitivity here as
  // additional Signal entries (financial, health, credentials → higher tiers). Recall expansion
  // (more entity detectors) is the follow-on plan; this task preserves existing coverage + the
  // fail-safe default.
];

export function classifySensitivity(text: string): SensitivityResult {
  const matched = SIGNALS.filter((s) => s.test.test(text));
  if (matched.length === 0) {
    return { tier: "public", confidence: "low", classified: false, reasons: [] };
  }
  // Pick the highest-tier match as the governing classification.
  const order: SensitivityTier[] = ["public", "personal", "private_consequential", "sensitive", "secret_never_send"];
  const top = matched.reduce((a, b) => (order.indexOf(b.tier) > order.indexOf(a.tier) ? b : a));
  return { tier: top.tier, confidence: top.confidence, classified: true, reasons: matched.map((m) => m.reason) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sensitivity.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sensitivity.ts src/sensitivity.test.ts
git commit -m "feat: fail-safe sensitivity classifier contract (no default-public)"
```

---

## Task 2: Allowlist gate predicate (`zeroTouchEligible`)

**Files:**
- Modify: `src/sensitivity.ts`
- Modify: `src/sensitivity.test.ts`

**Interfaces:**
- Consumes: `SensitivityResult`, `sensitivityConfidenceRank` (Task 1).
- Produces: `zeroTouchEligible(item: { sensitivity: SensitivityTier; sensitivityConfidence: SensitivityConfidence; sensitivityClassified: boolean }, policy: { requiresApprovalAbove?: SensitivityTier; zeroTouchConfidenceBar?: SensitivityConfidence }): boolean` and `sensitivityRank(t: SensitivityTier): number`.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/sensitivity.test.ts
import { zeroTouchEligible } from "./sensitivity";

describe("zeroTouchEligible", () => {
  const policy = { requiresApprovalAbove: "personal" as const, zeroTouchConfidenceBar: "medium" as const };
  it("is false when unclassified even if nominal tier is public", () => {
    expect(zeroTouchEligible({ sensitivity: "public", sensitivityConfidence: "low", sensitivityClassified: false }, policy)).toBe(false);
  });
  it("is false when classified but confidence below the bar", () => {
    expect(zeroTouchEligible({ sensitivity: "public", sensitivityConfidence: "low", sensitivityClassified: true }, policy)).toBe(false);
  });
  it("is true when classified, confidence ≥ bar, and rank ≤ threshold", () => {
    expect(zeroTouchEligible({ sensitivity: "personal", sensitivityConfidence: "high", sensitivityClassified: true }, policy)).toBe(true);
  });
  it("is false when rank above threshold", () => {
    expect(zeroTouchEligible({ sensitivity: "sensitive", sensitivityConfidence: "high", sensitivityClassified: true }, policy)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/sensitivity.test.ts` — Expected: FAIL (`zeroTouchEligible` not exported).

- [ ] **Step 3: Implement**

```ts
// add to src/sensitivity.ts
const TIER_RANK: Record<SensitivityTier, number> = {
  public: 0, personal: 1, private_consequential: 2, sensitive: 3, secret_never_send: 4,
};
export function sensitivityRank(t: SensitivityTier): number { return TIER_RANK[t]; }

export function zeroTouchEligible(
  item: { sensitivity: SensitivityTier; sensitivityConfidence: SensitivityConfidence; sensitivityClassified: boolean },
  policy: { requiresApprovalAbove?: SensitivityTier; zeroTouchConfidenceBar?: SensitivityConfidence },
): boolean {
  const threshold = policy.requiresApprovalAbove ?? "personal";
  const bar = policy.zeroTouchConfidenceBar ?? "medium";
  return (
    item.sensitivityClassified &&
    sensitivityConfidenceRank(item.sensitivityConfidence) >= sensitivityConfidenceRank(bar) &&
    sensitivityRank(item.sensitivity) <= sensitivityRank(threshold)
  );
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/sensitivity.test.ts` — Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sensitivity.ts src/sensitivity.test.ts
git commit -m "feat: allowlist zero-touch eligibility predicate"
```

---

## Task 3: Data-model fields (`src/types.ts`)

**Files:**
- Modify: `src/types.ts` (`MemoryCandidate` ~163, `MemoryProposal` ~182, `ApprovedFact` ~211, `ContextPackItem` ~231, the access-policy type)

**Interfaces:**
- Produces: new required fields `sensitivityClassified: boolean` and `sensitivityConfidence: "low"|"medium"|"high"` on `MemoryCandidate`, `MemoryProposal`, `ApprovedFact`, `ContextPackItem`; optional `zeroTouchConfidenceBar?: SensitivityConfidence` on the access-policy type.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/sensitivity.test.ts — type-level guard compiled by tsc
import type { ApprovedFact, MemoryCandidate, ContextPackItem } from "./types";
it("data model carries sensitivityClassified + sensitivityConfidence", () => {
  const f = {} as ApprovedFact; const c = {} as MemoryCandidate; const p = {} as ContextPackItem;
  // @ts-expect-error these must exist after Task 3
  const ok = f.sensitivityClassified === true && c.sensitivityClassified === true && p.sensitivityClassified === true
    && f.sensitivityConfidence === "high" && c.sensitivityConfidence === "high" && p.sensitivityConfidence === "high";
  expect(typeof ok).toBe("boolean");
});
```

(The `@ts-expect-error` is removed in Step 3 once fields exist; before that, `npm run build` fails to compile usage — see Step 2.)

- [ ] **Step 2: Run to verify it fails** — Run: `npm run build` — Expected: tsc errors that the properties don't exist (and the `@ts-expect-error` is unused once added). This confirms the fields are absent.

- [ ] **Step 3: Implement** — add to each type. Example for `ApprovedFact` (after line 211 `sensitivity: SensitivityTier;`):

```ts
  sensitivity: SensitivityTier;
  sensitivityClassified: boolean;
  sensitivityConfidence: "low" | "medium" | "high";
```

Repeat the same two lines after the `detectedSensitivity` field in `MemoryCandidate` and `MemoryProposal`, and after `sensitivity` in `ContextPackItem`. In the access-policy type (search `requiresApprovalAbove` in `types.ts`), add:

```ts
  zeroTouchConfidenceBar?: "low" | "medium" | "high";
```

Remove the `@ts-expect-error` line from the test (fields now exist).

- [ ] **Step 4: Run to verify it passes** — Run: `npm run build` — Expected: clean (tsc + vite). Note: `vault.ts` construction sites now fail to compile because they don't set the new required fields — that is expected and fixed in Task 4. If you prefer green-between-tasks, make the two new fields optional here and tighten to required at the end of Task 4; otherwise proceed to Task 4 immediately.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/sensitivity.test.ts
git commit -m "feat: add sensitivityClassified + sensitivityConfidence to domain types"
```

---

## Task 4: Wire classifier through `vault.ts` (extract → approve → pack) + migration

**Files:**
- Modify: `src/vault.ts` (the `detectSensitivity` call sites; candidate construction; fact approval; pack-item build; the state-load/normalize path)
- Modify: `src/vault.test.ts`

**Interfaces:**
- Consumes: `classifySensitivity`, `zeroTouchEligible` (Tasks 1-2); new type fields (Task 3).
- Produces: every newly-created candidate/fact/pack-item carries `sensitivityClassified` + `sensitivityConfidence`; legacy-loaded records are normalized to `sensitivityClassified:false`, `sensitivityConfidence:"low"`.

- [ ] **Step 1: Write the failing test** (migration + extract behavior)

```ts
// append to src/vault.test.ts
import { zeroTouchEligible } from "./sensitivity";
it("legacy fact without sensitivity-classification normalizes to unclassified (zero-touch ineligible)", () => {
  const legacy = { /* minimal fact lacking the new fields */ } as any;
  const normalized = normalizeFactForLoad(legacy); // implement in vault.ts
  expect(normalized.sensitivityClassified).toBe(false);
  expect(zeroTouchEligible(normalized, { requiresApprovalAbove: "personal", zeroTouchConfidenceBar: "medium" })).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/vault.test.ts -t "legacy fact"` — Expected: FAIL (`normalizeFactForLoad` undefined).

- [ ] **Step 3: Implement**
  - Replace `detectSensitivity(text)` usages with `classifySensitivity(text)`, mapping its result onto the new fields (`detectedSensitivity = r.tier`, `sensitivityClassified = r.classified`, `sensitivityConfidence = r.confidence`). On fact approval, carry the candidate's classification onto the fact; on pack-item build, carry the fact's classification onto the item.
  - Add `normalizeFactForLoad(fact)` (and the candidate equivalent) applied in the state-load/normalize path: if `sensitivityClassified === undefined`, set `{ sensitivityClassified: false, sensitivityConfidence: "low" }`. This is the safe-side normalization guard (cf. the prior standing-delivery migration that wrongly auto-opted vaults — default OFF/unclassified, never ON).
  - At the delivery-eligibility decision in `vault.ts`, replace the rank-only check with `zeroTouchEligible(item, policy)`.

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/vault.test.ts` and `npm run build` — Expected: PASS + clean. If Task 3 fields were made optional, tighten them to required now and rebuild.

- [ ] **Step 5: Commit**

```bash
git add src/vault.ts src/vault.test.ts
git commit -m "feat: route classification through vault core; fail-safe migration normalization"
```

---

## Task 5: Rust mirror — `classify_sensitivity` + struct + carry fields

**Files:**
- Modify: `src-tauri/src/lib.rs` (`detect_sensitivity` ~4200, `sensitivity_rank` ~4252; candidate/fact/pack-item JSON construction; `mod tests`)

**Interfaces:**
- Produces: `fn classify_sensitivity(text: &str) -> SensitivityResult` where `struct SensitivityResult { tier: String, confidence: String, classified: bool, reasons: Vec<String> }` (`#[serde(rename_all = "camelCase")]`); JSON written for candidates/facts/pack-items includes `sensitivityClassified` (bool) and `sensitivityConfidence` (string).

- [ ] **Step 1: Write the failing test**

```rust
// in the #[cfg(test)] mod tests near the sensitivity helpers
#[test]
fn classify_no_signal_is_unclassified() {
    let r = classify_sensitivity("favorite coffee is a flat white");
    assert_eq!(r.classified, false);
    assert_eq!(r.tier, "public");
    assert_eq!(r.confidence, "low");
}
#[test]
fn classify_email_is_personal_high() {
    let r = classify_sensitivity("reach me at alice@example.com");
    assert!(r.classified);
    assert_eq!(r.tier, "personal");
    assert_eq!(r.confidence, "high");
}
```

- [ ] **Step 2: Run to verify it fails** — Run: `cargo test --manifest-path src-tauri/Cargo.toml classify_` — Expected: FAIL (function/struct not defined).

- [ ] **Step 3: Implement** — add the struct + `classify_sensitivity` mirroring Task 1 (port the existing `detect_sensitivity` keyword groups as signal rules; no-signal ⇒ `{tier:"public", confidence:"low", classified:false, reasons:[]}`). Update candidate/fact/pack-item JSON builders to include `sensitivityClassified` + `sensitivityConfidence` from the classification.

- [ ] **Step 4: Run to verify it passes** — Run: `cargo test --manifest-path src-tauri/Cargo.toml classify_` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: Rust mirror of fail-safe classifier; carry fields onto core JSON"
```

---

## Task 6: Rust allowlist gate + migration normalization + boundary tests

**Files:**
- Modify: `src-tauri/src/lib.rs` (the `requires_confirmation` gate ~1281-1285; the load/normalize path that builds `vault_state`; `mod tests`)

**Interfaces:**
- Consumes: `classify_sensitivity`, the new JSON fields (Task 5); `sensitivity_rank` (existing).
- Produces: gate now allowlist-based; legacy records without the fields normalize to `sensitivityClassified:false`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn unclassified_pack_item_requires_confirmation_even_if_rank_low() {
    // Build a pack whose item has sensitivity "public" but sensitivityClassified=false.
    // Assert confirm_context_pack_at_path / the gate yields requires_confirmation == true.
    // (Use the existing test harness/use_test_vault_key(); mirror an existing pack test.)
}
```

- [ ] **Step 2: Run to verify it fails** — Run: `cargo test --manifest-path src-tauri/Cargo.toml unclassified_pack_item` — Expected: FAIL (gate still denylist).

- [ ] **Step 3: Implement** — at `~1281-1285`, replace the denylist computation. Today it is roughly:

```rust
let requires_confirmation = approval_mode == "always_review"
    || sensitivity_rank(&max_sensitivity_included) > sensitivity_rank(&requires_approval_above);
```

Change to allowlist: confirmation is required unless EVERY included item is zero-touch-eligible. Compute per-item eligibility (`item.sensitivityClassified && confidence_rank(item.sensitivityConfidence) >= confidence_rank(bar) && sensitivity_rank(item.sensitivity) <= sensitivity_rank(requires_approval_above)`), reading `bar` from the policy's `zeroTouchConfidenceBar` (default `"medium"`). Add a `confidence_rank(&str)->u8` helper (`low=0,medium=1,high=2`). In the load/normalize path, default missing `sensitivityClassified` to `false`.

- [ ] **Step 4: Run to verify it passes** — Run: `cargo test --manifest-path src-tauri/Cargo.toml` — Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat: Rust allowlist zero-touch gate + fail-safe migration normalization"
```

---

## Task 7: One-shot local reclassify on upgrade + full gate

**Files:**
- Modify: `src/vault.ts` and `src-tauri/src/lib.rs` (a migration step run once on load when legacy unclassified facts exist)
- Modify: `src/vault.test.ts`, Rust `mod tests`

**Interfaces:**
- Consumes: `classifySensitivity` / `classify_sensitivity`; `normalizeFactForLoad`.
- Produces: on first load after upgrade, each legacy `sensitivityClassified:false` fact is re-run through the local classifier; if it now classifies positively, its fields update (so most auto-resolve to zero-touch-eligible without user review); anything still unclassified stays review-gated.

- [ ] **Step 1: Write the failing test**

```ts
it("upgrade reclassify promotes a legacy fact whose text classifies positively", () => {
  const legacy = makeLegacyFact("reach me at alice@example.com"); // classified:false initially
  const out = reclassifyLegacyFacts([legacy]); // implement
  expect(out[0].sensitivityClassified).toBe(true);
  expect(out[0].detectedSensitivity ?? out[0].sensitivity).toBe("personal");
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx vitest run src/vault.test.ts -t "upgrade reclassify"` — Expected: FAIL.

- [ ] **Step 3: Implement** `reclassifyLegacyFacts` (TS) + the Rust equivalent, invoked once in the normalize/load path for records that are `sensitivityClassified:false` AND have not yet been reclassified (guard with a one-shot marker, e.g. a vault-state schema version bump, to avoid re-running every load). Keep it local-only (no network).

- [ ] **Step 4: Run to verify it passes** — Run: `npx vitest run src/vault.test.ts` + `cargo test --manifest-path src-tauri/Cargo.toml` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/vault.ts src-tauri/src/lib.rs src/vault.test.ts
git commit -m "feat: one-shot local reclassify of legacy facts on upgrade"
```

---

## Task 8: Release gate

- [ ] **Step 1:** Run `npm run product:check`. Expected: tests, build, cargo test, bins, relay smoke, hosted-relay all pass. (NOTE: `cargo fmt --check` is pre-existing-red on master and is fixed separately by R3 / `rustfmt.toml`; if R3 has not landed, confirm this step's ONLY failure is the pre-existing fmt check and nothing introduced by this plan.)
- [ ] **Step 2:** Commit any test additions needed to satisfy the boundary-coverage convention; ensure `vault.test.ts` and Rust `mod tests` cover: unclassified ⇒ ineligible; below-bar ⇒ ineligible; eligible happy path; above-threshold ⇒ ineligible; migration normalization; upgrade reclassify.

---

## Self-Review

- **Spec coverage:** decision 3 (fail-safe) → Tasks 1,4,6; decision 8 (allowlist) → Tasks 2,6; decision 9 (migration lazy reclassify) → Tasks 4,7; decision 10 (deterministic, explainable `reasons[]`) → Task 1; confidence bar per-client policy → Tasks 2,3,6; §5 data model → Task 3. **Gap noted:** decision 10's *recall expansion* (more entity detectors) is deliberately a follow-on plan (`2026-06-22-classifier-signal-expansion.md`, to be written) shipped in the same release per R1 — Task 1 preserves existing keyword coverage so this plan is safe but review-heavy until that lands. Reason exposure in UI (ledger/review) is a UI follow-on, not in this core plan.
- **Placeholder scan:** Task 1's `SIGNALS` array explicitly says to port the existing `detectSensitivity` keyword groups (they exist in `vault.ts`); that is a concrete port, not a TODO. No other placeholders.
- **Type consistency:** `sensitivityClassified: boolean`, `sensitivityConfidence: "low"|"medium"|"high"` used identically in Tasks 3-7; `zeroTouchEligible` signature stable Tasks 2/4; Rust `classify_sensitivity`/`SensitivityResult` mirror TS names.
