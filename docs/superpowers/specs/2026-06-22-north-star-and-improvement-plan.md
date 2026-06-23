# Life Context Vault — North Star, Ideal State & Improvement Plan

Status: design (validated via grilling interview, 2026-06-22). Precedes implementation planning.
Scope: defines what the system is *for*, which elements are necessary vs not, and a sequenced plan
to close the gap. Implementation (writing-plans) follows per phase.

## 1. North Star

**A universal personal context layer that every one of the user's AI tools reads from.**

The decisive clarification: *universal* means **universally read**, not universally captured. The
value is that any AI client (Claude Desktop, Codex, ChatGPT, …) can draw on the same reviewed
personal context — not that the app vacuums up the user's whole digital life. The trust boundary is
the **means** that makes centralizing personal context safe enough to be worth doing; it is not, by
itself, the product's purpose.

This reframes the existing codebase (which is architected as a privacy-review *gateway*) toward
being *infrastructure*: the gateway properties remain load-bearing, but the goal they serve is reach
and frictionless consumption, governed by safety.

## 2. Ideal State

- **Universality from distribution.** Many AI clients consume the layer with minimal onboarding
  friction. Breadth of *ingestion* stays deliberate and curated.
- **Tiered trust.** Low-sensitivity context flows zero-touch (standing delivery); sensitive context
  is reviewed; tier-4 secrets never leave. Friction scales with sensitivity, not uniformly.
- **Fail-safe classification.** "No sensitive signal found" must **not** imply "safe to auto-send."
  Zero-touch requires *positive* evidence of low sensitivity with sufficient confidence; unknown or
  low-confidence content falls to review.
- **Local-only classification.** Sensitivity is determined on-device. Raw content is never sent to a
  cloud service to be classified — doing so would break the very boundary that justifies the layer.
- **Trust under zero-touch is held after the fact.** Removing the pre-delivery gate for low tiers is
  compensated by a non-blocking delivery notification + the disclosure ledger + one-tap revocation.
- **Relay is necessary and minimal.** *(Correction: the hosted relay was removed in Simplify 1.1.
  Cloud AI tools currently use copy/export fallback only. "Universal" now means "read by LOCAL MCP
  clients (Claude Desktop, Codex, …)". The relay decision may be revisited in a future release, but
  it is not currently present in the codebase.)*

## 3. Decision Ledger (validated)

| # | Question | Decision |
|---|----------|----------|
| 1 | North star | Universal personal context layer — universality via **being read**, not via capture |
| 2 | Friction model | **Tiered trust**: zero-touch low / review high / tier-4 never |
| 3 | Tiering safety | **Fail-safe** default — unknown is never silently public |
| 4 | Classification locale | **Local-only** (no leak); cloud classification is out |
| 5 | Ingestion | **Curated/deliberate**; broad auto-mass-capture is out of scope |
| 6 | Distribution | **Relay stays** (necessary); kill onboarding friction; broaden clients | *(Correction: relay removed in Simplify 1.1; currently local-MCP-only + copy fallback)* |
| 7 | Zero-touch trust | **Non-blocking notification + post-hoc ledger + revoke** |
| 8 | Zero-touch semantics | **Allowlist**: zero-touch iff (sensitivity ≤ threshold) ∧ (confidence ≥ bar) ∧ (not unclassified) |
| 9 | Migration | **Lazy re-classify**; legacy facts treated as *unclassified*; batch-classify locally on upgrade |
| 10 | Default classifier | **Deterministic signals primary** (explainable, lean); local model is opt-in |
| 11 | Notification | **OS notification**, coalesced in a short window, deep-linking to the ledger |
| + | Confidence bar | per-client policy knob (mirrors `requiresApprovalAbove`) + conservative global default |
| + | Reason exposure | classification reason shown in review and ledger ("personal: matches email pattern") |
| R1 | P0/P1 sequencing | ship fail-safe default **together with** the deterministic-signal expansion; local model follows |
| R3 | CI hygiene | add `rustfmt.toml` pinning 2-space indent so `cargo fmt --check` passes without reformatting |

R2 (the precise relay onboarding-friction mechanism) was deferred to design-time. *Correction (post-spec):
the relay was removed in Simplify 1.1. R2 is now reframed as LOCAL MCP onboarding friction: the
`installClaudeDesktopConfig` flow, the hard-coded dev path in the copy fallback, missing non-macOS
key env guidance, and unactionable dev/preview errors are the current friction points. Cloud clients
use copy-fallback only.*

## 4. Necessary vs Unnecessary Elements

### Necessary — KEEP / EXTEND / BUILD
- **Trust boundary, double-enforced** (`approve_candidate_with_options_at_path`;
  `ensure_context_pack_allowed_by_current_policy` / `safe_context_pack_for_client`). The foundation
  that makes centralization safe. KEEP.
- **Sensitivity tiers + standing-delivery zero-touch** (per-connection opt-in; approval modes
  `always_review` / `explicit_sensitive`; gate at `src-tauri/src/lib.rs:~1284`). KEEP/EXTEND.
- **Fail-safe allowlist gate + confidence + `unclassified` state** — the largest current gap. BUILD.
- **Deterministic classifier expansion** (entities: email/phone/address/financial/health/credentials;
  source-based priors), replacing the keyword-only, default-`public`, fail-open
  `detectSensitivity` (`src/vault.ts`). BUILD.
- **Opt-in local classification provider** — env-gated local command mirroring `LCV_OCR_COMMAND` /
  `LCV_LEGACY_OFFICE_COMMAND` (bounded, stdout-capped). BUILD (after deterministic baseline).
- **Distribution stack** (`lcv-mcp` + the app's Claude-config installer): *(Correction: `lcv-relay`
  and `lcv-agent` were removed in Simplify 1.1. Current distribution is local MCP via
  `installClaudeDesktopConfig` + copy fallback for cloud clients.)* Broaden supported local clients;
  minimize `installClaudeDesktopConfig` friction; relay may return in a future phase. INVEST.
- **Disclosure ledger + revocation** (Home timeline) and **non-blocking OS delivery notification**
  on the existing tray / AI-access-supervisor. KEEP / ADD.
- **Metadata-only audit receipts** (no pack/source/candidate bodies). KEEP.

### Unnecessary / Out of scope / Cut
- **Broad automatic mass-ingestion** (email/notes/calendar/history auto-vacuum) — scope creep,
  surveillance-like, and it multiplies classifier risk. OUT.
- **Cloud classification of raw content** — breaks the boundary. OUT.
- **Relay feature expansion** beyond multi-client reach — keep the surface minimal. CONSTRAIN.
- **Legacy/dead UI** (already being removed: HomeView, SourcesView, InboxView). CONTINUE CUTTING.

## 5. Architecture Changes Implied

1. **Classification output contract** becomes `{ sensitivity, confidence, classified: bool, reasons[] }`
   instead of a bare sensitivity string. `detectSensitivity` is replaced by a deterministic
   signal-based classifier that returns this richer result and **never defaults to `public`** — absence
   of signal yields `classified: false` (unclassified), low confidence.
2. **Data model** gains, on candidates/facts: `sensitivityConfidence` and an `unclassified` notion
   (either a distinct sensitivity value or `classified=false`). The persisted `vault_state` JSON is
   TS-shaped; projection tables resync.
3. **Zero-touch gate** (`lib.rs:~1284`) changes from denylist to allowlist:
   `requires_confirmation = always_review || !(classified && confidence ≥ bar && sensitivity_rank ≤ threshold_rank)`.
   The per-client confidence `bar` joins `requiresApprovalAbove` in the access policy.
4. **Local classification provider**: env-gated command (text in → `{sensitivity,confidence,reasons}`
   JSON out), bounded like the OCR/Office providers; absent → deterministic-only.
5. **Migration**: existing facts without confidence are `unclassified` (zero-touch-ineligible until
   re-classified). On upgrade, run the new deterministic classifier over them locally to assign
   confidence so most auto-resolve. Default to the safe side; include a normalization guard (cf. the
   prior standing-delivery migration that wrongly auto-opted vaults in — same failure class to avoid).
6. **Non-blocking notification**: on zero-touch delivery, emit a coalesced OS notification via the
   AI-access supervisor / tray, deep-linking to the ledger; gated by an OS-permission opt-in.
7. **Reason exposure**: surface `reasons[]` in the review UI and the disclosure ledger.

All of the above is boundary-relevant and must extend `src/vault.test.ts` and the Rust `mod tests`,
and pass `npm run product:check`, per repo convention.

## 6. Sequenced Improvement Plan

- **P0 + P1a (one release) — close the fail-open hole.** Replace `detectSensitivity` with the
  deterministic signal-based classifier (richer entity + source-prior signals) returning
  `{sensitivity, confidence, classified}` and never defaulting to `public`; switch the zero-touch gate
  to allowlist semantics; add the per-client confidence bar with a conservative global default; ship
  the lazy-reclassify migration with the safe default + normalization guard. Bundling P0 with the
  signal expansion (R1) prevents an out-of-box review-flood. *Highest risk, do first.*
- **P1b — opt-in local model provider.** Env-gated local command to raise recall for power users;
  deterministic remains the default and the floor.
- **P2 — non-blocking OS delivery notification**, coalesced, deep-linked to the ledger; complements
  the existing post-hoc timeline.
- **P3 — distribution onboarding friction.** *(R2 reframed post-Simplify 1.1: relay removed; friction
  is now the LOCAL MCP `installClaudeDesktopConfig` flow, hard-coded dev path, missing non-macOS key
  env, and unactionable dev/preview errors.)* Streamline local MCP setup and broaden supported clients.
- **P4 — scope discipline.** Explicitly decline auto-mass-capture; keep ingestion curated. Document the
  boundary so future work doesn't drift toward surveillance.
- **Cross-cutting — CI hygiene (R3).** Add `rustfmt.toml` (2-space) so `product:check`'s
  `cargo fmt --check` passes without a repo-wide reformat, making the release gate meaningful again.

## 7. Open Items (resolve during design)
- **R2 — relay onboarding mechanism.** *(Reframed post-Simplify 1.1: relay removed. Friction is now
  the local MCP `installClaudeDesktopConfig` flow — hard-coded dev sidecar path, missing non-macOS
  `LCV_VAULT_DB_KEY` guidance, and unactionable errors in the browser/dev preview. Resolve by
  measuring the local MCP install flow in code.)*
- **Confidence calibration.** What confidence the deterministic signals actually emit, and where the
  global default bar sits, needs empirical tuning against real vault content.
- **`unclassified` representation.** Distinct sensitivity value vs `classified=false` flag — pick one
  in the data-model design; affects projection/FTS and the gate predicate.
