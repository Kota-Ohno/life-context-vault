# Classifier Recall Expansion — Structured Sensitive-Entity Detectors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Raise classifier recall on the SAFE side by adding tight, structured detectors for sensitive
entities (phone-number formats, postal addresses, credit cards, government IDs, IBAN/bank numbers) so
content that bare keywords miss is classified at the correct (sensitive) tier instead of falling to
`unclassified`/`public`. Follow-on to P0 (ships same release per R1). Scope ① only — NO positive-benign
classification this round.

**Architecture:** Extend the existing classifier `SIGNALS` (TS `src/sensitivity.ts`, Rust
`classify_sensitivity` in `src-tauri/src/lib.rs`) with new structured detectors. Some need a predicate
(Luhn for cards), so extend the matcher to accept `RegExp | (text) => boolean`. NO data-model / gate /
migration changes — this only adds positive-evidence signals at correct tiers. TS↔Rust parity required.

**Tech Stack:** TS (Vitest) + Rust (`#[cfg(test)] mod tests`). Reuse the P0 classifier contract.

**Source of truth:** `docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md` (decision 10,
"deterministic signals … entities"); follows P0 plan `2026-06-22-failsafe-classification-allowlist-gate.md`.

## Global Constraints
- **Dual core parity:** every detector added to TS `SIGNALS` must be mirrored in Rust `classify_sensitivity`
  at the SAME tier + confidence, and vice versa. Parity tests both directions.
- **Tight detectors only (FALSE POSITIVES are the hazard).** The P0 review already caught an over-broad
  phone regex matching any 8+ digit run. Every new detector must have explicit FALSE-POSITIVE tests
  proving benign text (e.g. `"in 2024 we sold 12345678 units"`, `"call me maybe"`, a lone 5-digit number)
  does NOT trigger. Prefer structure (separators, check digits, anchoring keywords) over loose digit runs.
- **Tier assignment (fixed):**
  - Credit card (Luhn-valid), US SSN, JP マイナンバー number, IBAN/bank-account number → `secret_never_send`,
    `high` (these must never leave; consistent with credentials).
  - Phone-number format, postal/physical address → `personal`, `high` (PII, deliverable-with-review).
- Structured matches are `high` confidence; do not add new `low` keyword signals here.
- Do NOT change tiers/confidence of EXISTING P0 signals, the reducer, the gate, types, or migration.
- No `cargo fmt` run is needed for correctness, but the tree is now rustfmt-2-space (R3) — keep new Rust
  code 2-space and rustfmt-clean (`product:check` enforces `cargo fmt --check`).

## File Structure
- `src/sensitivity.ts` — extend `Signal` matcher (`RegExp | (s: string) => boolean`), update the filter,
  add the new structured detectors + a Luhn helper.
- `src/sensitivity.test.ts` — positive + false-positive tests per detector.
- `src-tauri/src/lib.rs` — mirror detectors in `classify_sensitivity` (+ Luhn helper) + tests.

---

## Task 1: TS structured entity detectors

**Files:** `src/sensitivity.ts`, `src/sensitivity.test.ts`.

**Interfaces — Produces:** `Signal.test: RegExp | ((s: string) => boolean)`; new detectors appended to
`SIGNALS`; `luhnValid(digits: string): boolean` helper.

- [ ] **Step 1 — failing tests** (positive AND false-positive for each):
  - phone: `"+1 (415) 555-0132"` ⇒ `personal`/`high`; `"in 2024 we sold 12345678 units"` ⇒ NOT phone.
  - SSN: `"SSN 123-45-6789"` ⇒ `secret_never_send`/`high`; `"order 123-45-6789-00"` (wrong shape) ⇒ not SSN.
  - card: `"4111 1111 1111 1111"` (Luhn-valid) ⇒ `secret_never_send`/`high`; `"1234 5678 9012 3456"` (Luhn-invalid) ⇒ NOT card.
  - IBAN: `"DE89 3704 0044 0532 0130 00"` ⇒ `secret_never_send`/`high`; a random alnum run ⇒ not IBAN.
  - マイナンバー number: `"マイナンバーは 1234 5678 9012"` ⇒ `secret_never_send`/`high`.
  - address: `"123 Main Street, Springfield"` ⇒ `personal`/`high`; `"Chapter 123 main idea"` ⇒ NOT address.
- [ ] **Step 2 — run, expect FAIL** — `npx vitest run src/sensitivity.test.ts`.
- [ ] **Step 3 — implement:**
  - Change `interface Signal { test: RegExp | ((s: string) => boolean); ... }`; in `classifySensitivity`,
    match via `const ok = typeof s.test === "function" ? s.test(text) : s.test.test(text);`.
  - Add `luhnValid(digits)` (standard Luhn). Card detector: regex to find 13-19 digit groups (allowing
    spaces/hyphens), strip separators, then `luhnValid` — function matcher.
  - Phone: require structure — optional `+`/country, then grouped digits with separators or parens,
    e.g. `/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)|\d{2,4})[\s.-]\d{2,4}[\s.-]\d{2,4}/` AND a length/format
    guard so bare digit runs don't match. (Keep the existing bare `phone` keyword at `low`.)
  - SSN: `/\b\d{3}-\d{2}-\d{4}\b/`. IBAN: `/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,3}\b/`.
    マイナンバー number: a 12-digit number (optionally grouped 4-4-4) NEAR the マイナンバー keyword, OR a
    standalone 4-4-4 grouped 12-digit — keep tight to avoid FP.
  - Address: require a house number + street-suffix word
    (`/\b\d{1,5}\s+([A-Za-z]+\s+){0,3}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct)\b/i`)
    OR JP `〒\d{3}-\d{4}`. Conservative.
  - Each new detector: `tier`/`confidence` per the Global Constraints; meaningful `reason`.
- [ ] **Step 4 — run, expect PASS** — `npx vitest run src/sensitivity.test.ts` (incl. all FP tests).
- [ ] **Step 5 — commit** — `feat: structured sensitive-entity detectors (phone/SSN/card/IBAN/address) TS`.

---

## Task 2: Rust mirror (parity)

**Files:** `src-tauri/src/lib.rs` (`classify_sensitivity` + `mod tests`).

**Interfaces — Consumes:** Task 1's detector set + tiers. **Produces:** the same detectors in Rust with a
`luhn_valid(&str) -> bool` helper; the Rust matcher already supports function-style scanners (e.g.
`match_email`, `match_credential_assignment`) — add analogous `match_phone`, `match_card_luhn`,
`match_ssn`, `match_iban`, `match_my_number`, `match_address` and wire them into the signal list.

- [ ] **Step 1 — failing tests** mirroring Task 1's positive + false-positive cases, PLUS a parity table
  test: each entity input classifies at the SAME tier+confidence as TS (enumerate).
- [ ] **Step 2 — run, expect FAIL** — `cargo test --manifest-path src-tauri/Cargo.toml classify_`.
- [ ] **Step 3 — implement** the mirrored detectors + `luhn_valid`. Keep regex/scanners tight (mirror TS).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** — `feat: Rust mirror of structured sensitive-entity detectors + parity tests`.

---

## Task 3: Release gate + cross-core FP/parity verification

- [ ] **Step 1 — `npm run product:check`** — must pass fully (now that R3 made it green): tests, build,
  `cargo fmt --check` (keep new Rust 2-space rustfmt-clean — run `cargo fmt` on the new code if needed),
  `cargo test`, bins, smokes, `git diff --check`.
- [ ] **Step 2 — FP/parity audit:** confirm both suites include, for every new detector, a positive case
  AND a false-positive case, and a TS↔Rust parity assertion. List any detector lacking an FP test and add it.
- [ ] **Step 3 — commit** any test additions — `test: false-positive + parity coverage for entity detectors`.

## Self-Review
- Spec coverage: decision 10 "deterministic signals (entities)" → T1/T2; safe-side recall (scope ①) →
  all detectors raise sensitivity, none assert benign-public. Tier table applied uniformly.
- No placeholder: each detector has a concrete regex/predicate + a false-positive guard.
- Type/parity consistency: `Signal.test` union (TS) ↔ Rust scanner functions; same tier+confidence both cores.
- Out of scope (noted): positive-benign / source-prior classification (scope ②) — deferred.
