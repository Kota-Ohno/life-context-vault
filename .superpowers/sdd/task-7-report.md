# Task 7 Report — Rust gate flip + retrieval re-validation + durable migration + edit reclassify

**Status:** DONE
**Commit:** `48d7365` — "feat(gate): Task 7 — zero-touch gate + retrieval re-validation + durable migration + edit reclassify"
**Branch:** `feat/p0-failsafe-classification` (fast-forwarded from the implementation worktree)
**Scope:** `src-tauri/src/lib.rs` only (1 file, +501 / -7).
**Tests:** 128 passed, 1 ignored (large retrieval benchmark), 0 failed — full `cargo test --manifest-path src-tauri/Cargo.toml` green.

## What was implemented

### New helpers
- `zero_touch_eligible(item, threshold, bar) -> bool` — per-item allowlist predicate:
  `classified == true && confidence_rank(conf) >= confidence_rank(bar) && sensitivity_rank(tier) <= sensitivity_rank(threshold)`.
  Fails closed on missing fields (unclassified / missing tier ⇒ ineligible), consuming Task 6's projection fields.
- `policy_zero_touch_confidence_bar_for_client(vault, client_id) -> String` — mirrors
  `policy_requires_approval_above_for_client`; reads `zeroTouchConfidenceBar` from the connection's access policy,
  defaults to `"medium"`.
- `const CLASSIFIER_MIGRATION_VERSION: u32 = 1;` + `migrate_classification_if_needed(connection)`.

### Constraint 1 — Build gate (create_native_context_pack_request_in_connection, ~1321)
Kept the `approval_mode == "always_review" ||` term; replaced the max-tier denylist compare with the
per-item allowlist fold:
`|| !items.iter().all(|it| zero_touch_eligible(it, &requires_approval_above, &bar))`.
Empty items ⇒ `all()` is vacuously true ⇒ not required (matches prior behavior).

### Constraint 2 — Per-client bar
`bar` is read from `policy_zero_touch_confidence_bar_for_client(vault, client_id)` at the gate (default `"medium"`).

### Constraint 3 — Retrieval re-validation (ensure_context_pack_allowed_by_current_policy, ~3403)
SECOND enforcement point. Inside the items loop, for packs whose `confirmationStatus == "not_required"`
(i.e. zero-touch-delivered), each item is re-checked with `zero_touch_eligible`. An item that is now
unclassified / below-bar (because the underlying fact changed) causes the function to return its
policy-violation/expired result — verified by test to actually downgrade, not a no-op.

### Constraint 4 — Durable migration (open_vault_db_at_path, ~399)
`migrate_classification_if_needed` is invoked once after `sync_normalized_tables_if_stale`. It loads canonical
`vault_state`; if persisted `classifierMigrationVersion` (a NEW vault_state field, NOT the always-rewritten
`version`) is below CURRENT (=1), it back-fills missing classification fields on legacy/unclassified facts,
sets `classifierMigrationVersion=1`, and writes back via `save_vault_json_with_projection` (bumps updated_at,
rebuilds projection, backfilling Task 6's columns). If the marker is already current ⇒ strict NO-OP (no write,
no updated_at churn) — verified by `migration_durability_second_open_is_no_op`.

### Constraint 5 — Edit-fact reclassify (update_fact_metadata_at_path, ~2932)
On `factText` change, re-runs `classify_sensitivity` on the new text and sets the classification fields.
On a manual `sensitivity` override (text unchanged), sets `sensitivityClassified = false` — mirroring TS
`updateFactMetadata`. Also added `classify_sensitivity` at approval time in
`approve_candidate_with_options_at_path` so facts are classified immediately rather than deferred to migration.

## Tests added (7 new + 1 updated)
1. `gate_unclassified_item_requires_confirmation` — unclassified/low-rank ⇒ requires confirmation.
2. `gate_always_review_still_requires_confirmation_even_if_all_eligible` — always_review override.
3. `gate_mixed_pack_one_unclassified_requires_confirmation` — mixed pack ⇒ required.
4. `gate_per_client_bar_high_forces_high_confidence` — per-client bar "high".
5. `retrieval_revalidation_rejects_pack_when_item_becomes_unclassified` — second enforcement downgrade.
6. `migration_durability_second_open_is_no_op` — fields persisted after one open; second open no-op.
7. `edit_fact_reclassifies_when_text_changes` — edit reclassify.
- Updated `standing_delivery_flag_governs_mcp_auto_delivery` to use a classifiable (email) fact so zero-touch
  delivery still passes when items ARE eligible.

## Concerns
- The commit's `Co-Authored-By` trailer reads "Claude Sonnet 4.6" rather than the canonical Opus trailer; cosmetic,
  does not affect the diff.
- Approval-time classification was added to `approve_candidate_with_options_at_path` (beyond the literal 5 anchors)
  so newly approved facts are classified immediately and not solely reliant on the one-shot migration. This keeps
  the gate meaningful for facts created after migration ran. Worth a reviewer glance for parity with the TS approve path.
- `cargo fmt` was intentionally NOT run, per the brief.

---

## Fix-subagent pass — TS↔Rust divergence alignment (review findings)

**Status:** DONE
**Scope:** `src/vault.ts`, `src/vault.test.ts`, `src-tauri/src/lib.rs`

### Changes made

**1. TS `updateFactMetadata` — two-branch logic (mirrors Rust)**
- Previous: always set `sensitivityClassified: false` regardless of what changed.
- Fixed: override branch fires first when `input.sensitivity !== fact.sensitivity` → sets
  `sensitivityClassified: false, sensitivityConfidence: "low"`. Text-only change branch
  runs `classifySensitivity(newText)` and writes result. No-change (domain-only) edit
  leaves classification fields untouched via empty spread (`classificationPatch = {}`).

**2. Rust `update_fact_metadata_at_path` — branch order + missing confidence on override**
- Previous: text-change branch was checked FIRST, so a simultaneous text+sensitivity change
  would re-classify instead of clearing. Also: override branch never set `sensitivityConfidence`.
- Fixed: override branch (`sensitivity != old_sensitivity`) is now first; sets both
  `sensitivityClassified = false` AND `sensitivityConfidence = "low"`. Text-only change
  branch is second.

**3. Rust `migrate_classification_if_needed` — absent-only backfill**
- Previous: used `unwrap_or(false)` so facts with explicit `sensitivityClassified: false`
  (manually overridden) were re-classified on migration — silently promoting them.
- Fixed: checks `fact.get("sensitivityClassified").is_some()` — only back-fills facts
  where the key is completely absent from the JSON. Explicit false is preserved.

**4. TS `reclassifyLegacyFacts` + `normalizeVaultState` — absent-only backfill**
- Previous: `normalizeFactForLoad` defaults absent `sensitivityClassified` to `false`,
  then `reclassifyLegacyFacts` re-classified ALL facts (including deliberately-cleared ones).
- Fixed: `normalizeVaultState` collects `absentClassificationIds` (fact IDs where
  `sensitivityClassified` is `undefined`/`null` in raw parsed data) BEFORE calling
  `normalizeFactForLoad`. Passes this set to `reclassifyLegacyFacts`, which now skips
  facts not in the set.
- `reclassifyLegacyFacts` signature extended with optional `absentClassificationIds?: Set<string>`;
  when absent (legacy callers / tests using the state-only path) it falls back to the old
  reclassify-all behavior for backward compatibility.

### Tests added/updated
- Updated existing test: added `sensitivityConfidence: "low"` assertion on manual override.
- New TS: `updateFactMetadata text-only edit re-classifies the new text (classified=true)`
- New TS: `updateFactMetadata manual override wins even when text also changes`
- New TS: `updateFactMetadata domain-only edit leaves classification fields unchanged`
- New TS: `reclassifyLegacyFacts does NOT overwrite explicit sensitivityClassified=false`
- Updated Rust `edit_fact_reclassifies_when_text_changes`: now passes `&original_sensitivity`
  (unchanged) so only the text-change branch fires.
- New Rust `edit_fact_manual_sensitivity_override_clears_classification`: verifies
  classified=false + confidence=low when sensitivity changes (even with text also changing).

### Test results
- TS: 45 passed, 0 failed (`npx vitest run src/vault.test.ts`)
- Rust: 129 passed, 0 failed, 1 ignored (`cargo test --manifest-path src-tauri/Cargo.toml`)

---

## Final fix-subagent pass — C1 trust-boundary leak + I1 stale assertion

**Status:** DONE
**Branch:** `feat/p0-failsafe-classification`

### I1 — Stale domain assertion (vault.test.ts:1483)
Changed `expect(updated.domain).toBe("work_and_career")` → `"work_and_education"` to match the
test input at line 1477.

### C1 — Approve-with-edited-text sensitivity tier derivation (lib.rs ~3092)
**The leak:** `approve_candidate_with_options_at_path` computed `classify_sensitivity(&fact_text)`
but used `detected_sensitivity` (the CANDIDATE'S original tier) as the fact's `sensitivity` field.
A user who edited a benign (`public`) candidate to inject `AWS_SECRET_ACCESS_KEY=abc123` would
get a fact with `sensitivity="public"` that passes the zero-touch gate and auto-delivers.

**The fix:** Determine whether the user actually changed the text (`text_was_edited`). If so:
1. Block if `classification.tier == "secret_never_send"` (mirrors TS/extract path).
2. Use `classification.tier` (edited-text tier) as the fact's `sensitivity`.

Non-edited path retains `detected_sensitivity` from the candidate (no behavior change).
Both paths always run `classify_sensitivity(&fact_text)` so `sensitivityClassified` /
`sensitivityConfidence` remain fresh on the new fact (preserving Task 7 zero-touch gate behavior).

### Tests added (TDD — written before fix, verified failing first)
- `approve_with_edited_text_injecting_secret_is_blocked` — editing a benign candidate to inject
  `AWS_SECRET_ACCESS_KEY=abc123secret` must be rejected with an error; 0 facts created.
- `approve_with_edited_text_uses_edited_text_sensitivity_tier` — editing a `public` candidate to
  include an email must produce a fact with `sensitivity == "personal"`, not `"public"`.

### Test results
- TS: 45 passed, 0 failed (`npx vitest run src/vault.test.ts`)
- Rust: 132 passed, 0 failed, 1 ignored (`cargo test --manifest-path src-tauri/Cargo.toml`)
- `npm run build`: clean (tsc + vite, EXIT:0)
