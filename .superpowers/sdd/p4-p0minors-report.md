# p4-p0minors implementation report

Date: 2026-06-23

## Tasks completed

### 1. P0 parity-hygiene — TS retrieval zero-touch confidence bar re-check

**File:** `src/vault.ts` — `contextPackPolicyViolation` (around line 1746)

Added zero-touch bar re-check mirroring Rust's `ensure_context_pack_allowed_by_current_policy`
(lines 3644–3651 in `lib.rs`). For packs whose `confirmationStatus` is `"not_required"`,
`zeroTouchEligible` is re-run per item against the current per-client `requiresApprovalAbove`
and `zeroTouchConfidenceBar`. If any item fails, returns `"sensitivity_policy"`. User-confirmed
packs (`"confirmed"`) are exempt — the guard is inside `if (isZeroTouch)`.

Note on TS vs Rust semantics: in Rust, zero-touch packs retain `confirmationStatus = "not_required"`
at MCP retrieval. In TS, `confirmContextPack` is the gate — it calls `contextPackPolicyViolation`
before flipping the status to `"confirmed"`. So the bar re-check fires at confirmation time in TS,
which is the equivalent enforcement point.

### 2. P0 defense-in-depth test — pack-build secret filter pinned

**File:** `src/vault.test.ts`

Added `"pack-build secret filter: editing a candidate with injected secret excludes fact from pack"`.
Approves a candidate with `password=SuperSecret123...` injected via `editedText`; verifies:
- `approveCandidate` classifies the fact as `secret_never_send`
- `buildContextPackForRequest` produces zero pack items (secret facts are filtered from
  `rankFactsForTask` before the build loop, so they never reach `excludedItems` either — the
  correct security property is that they don't appear in `items`)

Also added two new tests for the zero-touch bar parity:
- `"retrieval re-validation: zero-touch pack blocked when confidence now below raised per-client bar"` —
  tightening `zeroTouchConfidenceBar` from `"medium"` to `"high"` causes `confirmContextPack` to
  cancel the `not_required` pack (`"cancelled"`)
- `"retrieval re-validation: user-confirmed pack is NOT blocked by raised per-client zero-touch bar"` —
  a `standingDeliveryEnabled: false` pack confirmed by the user remains deliverable after bar tightening

### 3. P4 scope-discipline docs

**File:** `CLAUDE.md` — new "Scope discipline" section added after "What this is"

**File:** `docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md` — paragraph
appended under the P4 bullet recording the deliberate boundary decision (2026-06-23).

## Test results

- 125 tests pass, 0 failures
- `npm run build` clean (tsc + vite)
- No Rust changes made
- No existing assertions weakened
