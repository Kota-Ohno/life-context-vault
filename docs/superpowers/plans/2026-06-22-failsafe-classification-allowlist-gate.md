# Fail-safe Sensitivity Classification & Allowlist Zero-touch Gate (P0 core) — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> v2 incorporates a fresh-eyes review (2026-06-22): adds the Rust projection-table data path, preserves the `always_review` short-circuit, updates the **second** (retrieval-time) enforcement point, threads the per-client confidence bar, hardens the edit-fact path, makes migration durable with a real one-shot marker, pins per-signal confidence, and audits existing-test breakage.

**Goal:** Make zero-touch delivery fail-safe — a Context Pack auto-delivers only when **every** included item has *positive* low-sensitivity evidence at sufficient confidence; unknown/low-confidence content falls to review — enforced identically in both cores and at **both** enforcement points (build and retrieval).

**Architecture:** Replace keyword-only, default-`public`, fail-open detection (TS `detectSensitivity`, Rust `detect_sensitivity`) with a classifier returning `{tier, confidence, classified, reasons}` that never defaults to `public` on no signal. Carry `sensitivityClassified` + `sensitivityConfidence` through candidate → fact → **facts projection table** → pack item. Change the gate from denylist (`maxRank > threshold`) to a per-item allowlist fold, **keeping** the `always_review` short-circuit, at both the build gate and the retrieval-time re-validation. Migrate legacy data as `unclassified` (fail-closed) with a durable one-shot local reclassify.

**Tech Stack:** React 19 + TS + Vite (`src/`); synchronous Rust (`std::sync::Mutex`) in `src-tauri/src/lib.rs`; SQLCipher projection tables. Vitest; Rust `#[cfg(test)] mod tests`.

**Source of truth:** `docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md` (decisions 3, 8, 9, 10; §5).

## Global Constraints

- **Dual core, behaviorally identical.** `src/vault.ts` (TS core) and `src-tauri/src/lib.rs` (`*_at_path`) BOTH carry classification + gate logic. Every behavior change lands in both with mirrored tests. A change in one core not mirrored in the other is a defect.
- **Boundary enforced TWICE.** Build-time gate (`requires_confirmation` / `confirmationStatus`) AND retrieval-time re-validation (`ensure_context_pack_allowed_by_current_policy` / TS `refreshEditedContextPack`, `restoreFactToPack`, confirm path). The allowlist must hold at BOTH; an item that becomes unclassified or below-bar after build must downgrade the pack at retrieval (pending/expired), never deliver.
- **Keep the `always_review` short-circuit.** The gate is `requires_confirmation = approval_mode == "always_review" || !ALL_ITEMS_ELIGIBLE`. Never drop the mode term — dropping it makes reviewed connections auto-deliver (a leak).
- **Per-item conjunctive fold.** Eligibility is per item: `classified ∧ confidence ≥ bar ∧ rank ≤ threshold`. A pack auto-delivers only if **every** item is eligible (`items.every(...)` / `items.iter().all(...)`). An empty item list is vacuously eligible ⇒ not_required (matches today; assert it).
- **Fail closed on missing data.** Absent `sensitivityClassified` (undefined/JSON-null/SQL-null) ⇒ treated as `false` (ineligible). The predicate is classified-first and short-circuits; never `unwrap_or(true)`.
- **Rust gate reads the projection, not JSON.** Pack items are built from `NativeFactSearchResult`, hydrated by SELECT against the **derived `facts` projection table**. The new fields must flow: canonical JSON → projection schema column → INSERT → SELECT → struct → row mapper → pack-item builder. Bump the projection schema version so existing DBs rebuild.
- **Per-signal confidence is a safety parameter.** Structured-pattern matches (email/phone/credential/financial regex) → `high`; bare keyword-group hits → `low` (they set the display tier/rank but stay zero-touch-INELIGIBLE at the default `medium` bar until the follow-on signal-expansion plan upgrades them).
- **Preserve high-tier recall & secret-first priority.** Port every existing `detect_sensitivity` keyword group with at least current tier coverage; credentials ⇒ `secret_never_send` (never zero-touch). Parity-test representative inputs classify at ≥ today's tier.
- **Existing `confidence` fields are NOT sensitivity confidence** (`MemoryCandidate.confidence` / `ApprovedFact.confidence` are extraction/provenance). Add new `sensitivityConfidence` + `sensitivityClassified`; do not overload.
- **SensitivityTier rank:** `public(0) < personal(1) < private_consequential(2) < sensitive(3) < secret_never_send(4)` (`src/types.ts:1`). **Confidence:** `low(0) < medium(1) < high(2)`; default zero-touch bar `"medium"`.
- **Do NOT run `cargo fmt`** (2-space tree, no rustfmt.toml — R3, separate). Each per-task commit must compile/build green (no knowingly-red intermediate).

---

## File Structure

- `src/sensitivity.ts` — **new.** `classifySensitivity(text)→SensitivityResult`, result/confidence types, `sensitivityConfidenceRank`, `sensitivityRank`, `zeroTouchEligible(item, policy)`. Holds the signal rules ported from `vault.ts:detectSensitivity`.
- `src/sensitivity.test.ts` — **new.** Classifier + predicate unit tests.
- `src/types.ts` — **modify.** Add `sensitivityClassified`/`sensitivityConfidence` to `MemoryCandidate`, `MemoryProposal`, `ApprovedFact`, `ContextPackItem`; `zeroTouchConfidenceBar?` on the access-policy type.
- `src/vault.ts` — **modify.** Classifier wiring on extract/approve/**edit**; per-client bar accessor + threading; build gate; retrieval-time re-validation; migration normalize + durable one-shot reclassify marker; carry fields onto pack items.
- `src/vault.test.ts` — **modify.** Boundary tests + fixture audit.
- `src-tauri/src/lib.rs` — **modify.** `SensitivityResult` + `classify_sensitivity`; **facts projection schema column + version bump + INSERT + SELECTs + `NativeFactSearchResult` + row mapper**; pack-item builder; build gate; retrieval re-validation; migration hook with write-back; edit-fact re-classify; bar accessor; Rust `mod tests` + fixture audit.

---

## Task 1: TS classifier contract + signal port (`src/sensitivity.ts`)

**Files:** Create `src/sensitivity.ts`, `src/sensitivity.test.ts`.

**Interfaces — Produces:** `SensitivityConfidence = "low"|"medium"|"high"`; `SensitivityResult = { tier: SensitivityTier; confidence: SensitivityConfidence; classified: boolean; reasons: string[] }`; `classifySensitivity(text): SensitivityResult`; `sensitivityConfidenceRank(c): number`; `sensitivityRank(t): number`.

- [ ] **Step 1 — failing tests** (`src/sensitivity.test.ts`): cover the load-bearing safety cases.

```ts
import { describe, it, expect } from "vitest";
import { classifySensitivity } from "./sensitivity";

describe("classifySensitivity", () => {
  it("no signal ⇒ unclassified, public, low (never default-public-classified)", () => {
    const r = classifySensitivity("favorite coffee is a flat white");
    expect(r.classified).toBe(false); expect(r.tier).toBe("public"); expect(r.confidence).toBe("low");
  });
  it("email ⇒ personal, HIGH, with reason", () => {
    const r = classifySensitivity("reach me at alice@example.com");
    expect(r.classified).toBe(true); expect(r.tier).toBe("personal"); expect(r.confidence).toBe("high");
    expect(r.reasons.join(" ")).toMatch(/email/i);
  });
  it("credential ⇒ secret_never_send (never zero-touch), preserving secret-first priority", () => {
    const r = classifySensitivity("my password is hunter2 and AWS_SECRET_ACCESS_KEY=abc");
    expect(r.tier).toBe("secret_never_send"); expect(r.classified).toBe(true);
  });
  it("bare keyword hit ⇒ classifies tier but LOW confidence (below default bar)", () => {
    // a plain keyword like "contract" with no structured pattern
    const r = classifySensitivity("we discussed the contract yesterday");
    expect(r.confidence).toBe("low"); // tier may be set, but low ⇒ zero-touch ineligible at medium bar
  });
});
```

- [ ] **Step 2 — run, expect FAIL** — `npx vitest run src/sensitivity.test.ts` (module missing).

- [ ] **Step 3 — implement.** Port EVERY keyword group currently in `src/vault.ts:detectSensitivity` (~vault.ts:2482) into `SIGNALS`, ordered secret-first, each with a tier AND a confidence per the Global Constraints (structured regex → `high`; bare keyword → `low`). Return the highest-tier match; no match ⇒ `{tier:"public",confidence:"low",classified:false,reasons:[]}`.

```ts
import type { SensitivityTier } from "./types";
export type SensitivityConfidence = "low" | "medium" | "high";
export interface SensitivityResult { tier: SensitivityTier; confidence: SensitivityConfidence; classified: boolean; reasons: string[]; }
const CONFIDENCE_RANK: Record<SensitivityConfidence, number> = { low: 0, medium: 1, high: 2 };
export function sensitivityConfidenceRank(c: SensitivityConfidence): number { return CONFIDENCE_RANK[c]; }
const TIER_RANK: Record<SensitivityTier, number> = { public:0, personal:1, private_consequential:2, sensitive:3, secret_never_send:4 };
export function sensitivityRank(t: SensitivityTier): number { return TIER_RANK[t]; }
interface Signal { test: RegExp; tier: SensitivityTier; confidence: SensitivityConfidence; reason: string; }
const SIGNALS: Signal[] = [
  // secret-first; structured patterns = high, bare keywords = low. Port ALL groups from detectSensitivity.
  { test: /\b(password|api[_-]?key|secret[_-]?access[_-]?key|private[_-]?key|bearer\s+[a-z0-9._-]{12,})\b/i, tier: "secret_never_send", confidence: "high", reason: "matches credential pattern" },
  { test: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, tier: "personal", confidence: "high", reason: "matches email pattern" },
  // ... remaining ported groups (financial/health/contact/contract): structured→high, keyword→low ...
];
export function classifySensitivity(text: string): SensitivityResult {
  const matched = SIGNALS.filter((s) => s.test.test(text));
  if (matched.length === 0) return { tier: "public", confidence: "low", classified: false, reasons: [] };
  const top = matched.reduce((a, b) => (TIER_RANK[b.tier] > TIER_RANK[a.tier] ? b : a));
  return { tier: top.tier, confidence: top.confidence, classified: true, reasons: matched.map((m) => m.reason) };
}
```

- [ ] **Step 4 — run, expect PASS** — `npx vitest run src/sensitivity.test.ts`.
- [ ] **Step 5 — commit** — `git commit -am "feat: fail-safe sensitivity classifier contract (no default-public; per-signal confidence)"`.

---

## Task 2: Allowlist predicate `zeroTouchEligible`

**Files:** Modify `src/sensitivity.ts`, `src/sensitivity.test.ts`.

**Interfaces — Produces:** `zeroTouchEligible(item: {sensitivity: SensitivityTier; sensitivityConfidence: SensitivityConfidence; sensitivityClassified: boolean}, policy: {requiresApprovalAbove?: SensitivityTier; zeroTouchConfidenceBar?: SensitivityConfidence}): boolean`. Fails closed on missing fields.

- [ ] **Step 1 — failing tests:** unclassified⇒false (even nominal public); classified+below-bar⇒false; classified+confidence≥bar+rank≤threshold⇒true; rank>threshold⇒false; **missing fields (undefined) ⇒ false (no throw)**.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** (classified-first short-circuit):

```ts
export function zeroTouchEligible(item, policy): boolean {
  const threshold = policy.requiresApprovalAbove ?? "personal";
  const bar = policy.zeroTouchConfidenceBar ?? "medium";
  return !!item.sensitivityClassified
    && sensitivityConfidenceRank(item.sensitivityConfidence) >= sensitivityConfidenceRank(bar)
    && sensitivityRank(item.sensitivity) <= sensitivityRank(threshold);
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** — `"feat: allowlist zero-touch eligibility predicate (fail-closed)"`.

---

## Task 3: Domain type fields (optional first, tightened in Task 4)

**Files:** Modify `src/types.ts`.

**Interfaces — Produces:** OPTIONAL (this task) `sensitivityClassified?: boolean`, `sensitivityConfidence?: "low"|"medium"|"high"` on `MemoryCandidate`, `MemoryProposal`, `ApprovedFact`, `ContextPackItem`; `zeroTouchConfidenceBar?` on the access-policy type. (Optional here so this commit compiles; Task 4 Step "tighten" makes them required after all construction sites are wired.)

- [ ] **Step 1** — add the optional fields to all four types + the policy type.
- [ ] **Step 2 — run** `npm run build` — expect CLEAN (optional fields break nothing).
- [ ] **Step 3 — commit** — `"feat: add optional sensitivity classification fields to domain types"`.

(Per fresh-eyes review: fields are optional here to avoid a knowingly-red commit; Task 4 tightens them to required once construction sites are wired.)

---

## Task 4: TS core wiring — extract, approve/EDIT, bar threading, build gate, retrieval re-validation, migration

**Files:** Modify `src/vault.ts`, `src/vault.test.ts`. Anchors: extract/`detectSensitivity` sites; `approveCandidate` (~525-552, editedText branch); `updateFactText`/`updateFactMetadata` (~955-985); build options/caller (~1189-1249); build gate `maxSensitivityIncluded`/`confirmationStatus` (~1305-1324); pack-item build (~1509); retrieval paths `restoreFactToPack` (~1344), `refreshEditedContextPack` (~1367), `contextPackPolicyViolation` (~1614-1657); `normalizeState` (~110-160).

**Interfaces — Consumes:** Tasks 1-2. **Produces:** `policyZeroTouchConfidenceBarForClient(state, clientId)`; `normalizeFactForLoad`/candidate equiv; `reclassifyLegacyFacts`; gate + retrieval re-validation using `zeroTouchEligible`.

- [ ] **Step 1 — failing tests** in `src/vault.test.ts`:
  1. **legacy normalize:** a fact without the fields ⇒ `normalizeFactForLoad` sets `{classified:false, confidence:"low"}`; `zeroTouchEligible(...)` false.
  2. **mixed pack:** a pack with one eligible item + one unclassified item ⇒ `confirmationStatus === "pending_user_confirmation"`.
  3. **always_review short-circuit:** approvalMode `always_review` with all-eligible items ⇒ still `pending_user_confirmation`.
  4. **empty pack:** zero items ⇒ `not_required` (vacuous), matching today.
  5. **edit adds secret:** approve-with-edited-text that introduces an email/credential ⇒ fact reclassified (not stale `classified:false`); **manual `updateFactMetadata` setting sensitivity=public ⇒ `sensitivityClassified=false`** (manual override is unverified ⇒ ineligible).
  6. **per-client bar:** policy `zeroTouchConfidenceBar:"high"` ⇒ a medium-confidence eligible-by-rank item ⇒ `pending_user_confirmation`.
  7. **retrieval re-validation:** a built+delivered pack whose fact is later normalized to unclassified ⇒ `refreshEditedContextPack`/`restoreFactToPack`/policy-violation path downgrades to pending/expired, NOT deliverable.
- [ ] **Step 2 — run, expect FAIL** (`normalizeFactForLoad`/`policyZeroTouchConfidenceBarForClient`/`reclassifyLegacyFacts` undefined; gate still denylist).
- [ ] **Step 3 — implement:**
  - **Classify on every text origin:** replace `detectSensitivity(text)` with `classifySensitivity(text)`, mapping `r.tier→detectedSensitivity`, `r.classified→sensitivityClassified`, `r.confidence→sensitivityConfidence`. On **approve-with-edited-text**, re-run `classifySensitivity` on the FINAL text. On **`updateFactText`**, re-classify the new text. On **`updateFactMetadata`** manual sensitivity override, set `sensitivityClassified=false` (unverified).
  - **Carry** the fact's fields onto each pack item at build (~1509).
  - **Bar accessor + threading:** add `policyZeroTouchConfidenceBarForClient(state, clientId)` (mirrors `policyRequiresApprovalAboveForClient`); pass the resolved bar into `buildContextPackWithOptions` options and into the `policy` arg of `zeroTouchEligible`.
  - **Build gate** (~1320-1324): `confirmationStatus = options.approvalMode === "always_review" || !items.every((i) => zeroTouchEligible(i, policy)) ? "pending_user_confirmation" : "not_required";`
  - **Retrieval re-validation:** in `refreshEditedContextPack` / `restoreFactToPack` / `contextPackPolicyViolation`, re-apply `!items.every(zeroTouchEligible)` (in addition to existing rank/expiry/domain/text-identity checks); if it now fails, downgrade to pending/expired.
  - **Migration:** in `normalizeState`, apply `normalizeFactForLoad`/candidate equiv (default missing ⇒ `{classified:false, confidence:"low"}`). Add `reclassifyLegacyFacts` guarded by a NEW one-shot marker `classifierMigrationVersion` (NOT the always-rewritten `version`): only run where `classifierMigrationVersion < CURRENT`; set it after. (See Task 7 for the durable marker semantics — keep TS and Rust markers identical.)
  - **Tighten** the four type fields from optional to **required** now that all construction sites set them; rebuild.
- [ ] **Step 4 — run, expect PASS** — `npx vitest run src/vault.test.ts` + `npm run build` clean.
- [ ] **Step 5 — commit** — `"feat: TS allowlist gate + retrieval re-validation + bar threading + edit reclassify + durable migration"`.

---

## Task 5: Rust classifier mirror (`classify_sensitivity`) with full group port + parity

**Files:** Modify `src-tauri/src/lib.rs` (near `detect_sensitivity` ~4200, `sensitivity_rank` ~4252) + `mod tests`.

**Interfaces — Produces:** `struct SensitivityResult { tier: String, confidence: String, classified: bool, reasons: Vec<String> }` (`#[serde(rename_all="camelCase")]`); `fn classify_sensitivity(text: &str) -> SensitivityResult`; `fn confidence_rank(c: &str) -> u8`.

- [ ] **Step 1 — failing tests** mirroring Task 1 incl. credential⇒`secret_never_send` and bare-keyword⇒`low`, PLUS a parity test: representative inputs classify at ≥ the tier `detect_sensitivity` returns today (enumerate each ported group).
- [ ] **Step 2 — run, expect FAIL** — `cargo test --manifest-path src-tauri/Cargo.toml classify_`.
- [ ] **Step 3 — implement** porting every keyword group secret-first with per-signal confidence (structured→`"high"`, keyword→`"low"`); no match ⇒ `{tier:"public",confidence:"low",classified:false}`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** — `"feat: Rust classifier mirror with full group port + parity tests"`.

---

## Task 6: Rust facts-projection data path (schema → INSERT → SELECT → struct → row mapper → pack item)

> **The critical gap from review.** The Rust gate reads pack items built from `NativeFactSearchResult`, hydrated by SELECT against the DERIVED `facts` projection table — not canonical JSON. The fields must flow through the projection.

**Files:** Modify `src-tauri/src/lib.rs`: `NativeFactSearchResult` (~109); facts projection schema (~507); `sync_normalized_tables` INSERT INTO facts (~775); fact SELECT lists incl. fts join (~1093-1145), and other SELECTs (~3676, ~3849); `row_to_native_fact_search_result` (~1056-1076); pack-item `json!` builder (~1256-1270); `mod tests`.

**Interfaces — Produces:** `facts` projection has `sensitivity_classified INTEGER` + `sensitivity_confidence TEXT`; `NativeFactSearchResult` carries both; pack items emit `sensitivityClassified`/`sensitivityConfidence` FROM the fact (no re-classify at build).

- [ ] **Step 1 — failing test:** build a pack via the native path from a fact whose canonical JSON has `sensitivityClassified:true,sensitivityConfidence:"high"`; assert the built pack item carries both (today it cannot — column/struct absent).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** (a) add the two columns to the `facts` projection schema (~507) and **bump the projection schema version** so existing DBs rebuild; (b) populate them in the `sync_normalized_tables` INSERT (~775) from canonical fact JSON, defaulting missing ⇒ `(0,"low")`; (c) add both fields to `NativeFactSearchResult` (~109) and every fact SELECT (~1093-1145, ~3676, ~3849) + `row_to_native_fact_search_result` (~1056); (d) emit them on the pack item (~1256-1270) from the fact; (e) confirm `sync_normalized_tables_if_stale` rebuilds on the version bump.
- [ ] **Step 4 — run, expect PASS** — `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] **Step 5 — commit** — `"feat: carry classification fields through the Rust facts projection to pack items"`.

---

## Task 7: Rust gate + retrieval re-validation + durable migration hook + edit-fact reclassify

**Files:** Modify `src-tauri/src/lib.rs`: build gate (~1277-1285); auto-delivery release (~1399); retrieval `ensure_context_pack_allowed_by_current_policy` (~3366) / `safe_context_pack_for_client` (~3309); migration at `load_vault_json_from_connection` (~1597) + the on-open migration site (where plaintext→encrypted / standing-delivery migrations run); edit-fact command (~3037-3043) + `context_pack_item_from_fact` (~3581); bar accessor mirroring `policy_requires_approval_above_for_client` (~6471); `mod tests`.

**Interfaces — Consumes:** Tasks 5-6. **Produces:** `policy_zero_touch_confidence_bar_for_client`; allowlist gate at build AND retrieval; durable migration that writes back + rebuilds projection.

- [ ] **Step 1 — failing tests:** (1) unclassified pack item with low rank ⇒ `requires_confirmation==true`; (2) `always_review` + all-eligible ⇒ still requires confirmation; (3) mixed pack (one unclassified) ⇒ requires confirmation; (4) per-client bar `"high"` forces high confidence; (5) **retrieval:** a fact normalized to unclassified ⇒ `ensure_context_pack_allowed_by_current_policy` rejects (pack becomes pending/expired); (6) **migration durability:** after one open, canonical `vault_state` JSON carries defaulted/reclassified fields AND a second open is a no-op (classifier not re-run; guard marker set); (7) **edit-fact:** editing fact text re-classifies.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:**
  - **Build gate** (~1284): `let requires_confirmation = approval_mode == "always_review" || !items.iter().all(|it| zero_touch_eligible(it, threshold, bar));` with `zero_touch_eligible` = `classified && confidence_rank(conf) >= confidence_rank(bar) && sensitivity_rank(tier) <= sensitivity_rank(threshold)`; read `bar` from `policy_zero_touch_confidence_bar_for_client` (default `"medium"`). Missing fields ⇒ classified false ⇒ ineligible.
  - **Retrieval** `ensure_context_pack_allowed_by_current_policy` (~3366): additionally re-apply the per-item allowlist; an item now unclassified/below-bar ⇒ return the policy-violation/expired result (mirror existing rank/expiry handling).
  - **Migration hook:** add a function that loads canonical `vault_state`, defaults missing classification fields, runs the guarded one-shot `reclassify` (guarded by a persisted `classifierMigrationVersion`, NOT the rewritten `version`), **writes `vault_state` back**, and marks the projection stale so it rebuilds. Anchor it to the on-open migration site (same place as plaintext→encrypted / standing-delivery migrations). Keep the marker value identical to TS.
  - **Edit-fact** (~3037-3043): re-run `classify_sensitivity` on edited text; manual sensitivity override ⇒ `sensitivityClassified=false`.
- [ ] **Step 4 — run, expect PASS** — `cargo test --manifest-path src-tauri/Cargo.toml`.
- [ ] **Step 5 — commit** — `"feat: Rust allowlist gate (build+retrieval) + durable classification migration + edit reclassify"`.

---

## Task 8: Existing-test fixture audit (both cores)

> Making the fields required + flipping denylist→allowlist changes many existing fixtures/assertions. Audit, don't rubber-stamp.

**Files:** `src/vault.test.ts` (~16 sensitivity literals), `src-tauri/src/lib.rs` `mod tests` (~37 `explicit_sensitive` pack tests, ~12 confirmation-status assertions).

- [ ] **Step 1 — audit:** for EACH existing pack/confirmation test, set the fixture's classification (`classified:true, confidence:"high"`) where the test INTENDS auto-delivery; add `classified:false` variants for the new fail-safe cases. A `not_required → pending_user_confirmation` flip is expected **only** where the fixture is unclassified — confirm each flip is intended, not a masked regression.
- [ ] **Step 2 — run** both suites; reconcile every changed assertion with a one-line justification in the commit body.
- [ ] **Step 3 — commit** — `"test: update sensitivity fixtures for allowlist gate (audited)"`.

---

## Task 9: Release gate

- [ ] **Step 1 — `npm run product:check`.** Expect tests, build, cargo test, bins, relay smoke, hosted-relay pass. (`cargo fmt --check` is pre-existing-red on master, fixed separately by R3; confirm it is the ONLY failure and nothing introduced here.)
- [ ] **Step 2 — boundary coverage check:** confirm both suites cover — unclassified⇒ineligible; below-bar⇒ineligible; eligible happy path; rank>threshold⇒ineligible; mixed-pack⇒pending; always_review⇒pending; empty-pack⇒not_required; per-client bar; edit-path reclassify + manual-override⇒unclassified; retrieval re-validation downgrade; migration default + durable one-shot; credential⇒secret_never_send.

---

## Self-Review

- **Spec coverage:** decision 3 (fail-safe) → T1,4,5,6,7; decision 8 (allowlist, per-item, both enforcement points) → T2,4,7; decision 9 (lazy reclassify, durable) → T4,7; decision 10 (deterministic, explainable `reasons`, per-signal confidence) → T1,5; per-client bar → T2,4,7; §5 data model + projection → T3,6. **Deferred (noted):** recall expansion (more entity detectors) is the follow-on `2026-06-22-classifier-signal-expansion.md`, shipped same release per R1; reason-exposure in UI is a UI follow-on.
- **Fresh-eyes findings → tasks:** projection path → T6; always_review short-circuit → T4,7 (verbatim in constraints); retrieval enforcement → T4,7; per-item fold → constraints + T4,7 + mixed-pack tests; bar threading → T4,7; Rust migration write-back/one-shot → T7; edit-fact fail-open → T4,7; per-signal confidence → T1,5 constraints; high-tier recall/priority → T1,5 parity tests; one-shot marker (not `version`) → T4,7 (`classifierMigrationVersion`); existing-test breakage → T8; non-compiling intermediate → T3 optional/T4 tighten; empty-pack vacuity → constraints + T4 test.
- **Type consistency:** `sensitivityClassified`/`sensitivityConfidence` identical TS↔Rust (camelCase wire / snake_case column); `zeroTouchEligible`/`zero_touch_eligible`, `classifySensitivity`/`classify_sensitivity` mirror; gate expression identical in both cores.
