# Simplify UX — "Simple & Easy First" Design

Status: design (validated via grilling, 2026-06-23). Precedes implementation planning.
Priority: **simple & easy to use, above all.** The biggest barrier identified is **conceptual overload** —
the user must currently learn candidate / Fact / Context Pack / sensitivity (5 tiers) / confidence /
standing-delivery / zero-touch / approval-modes to get value. This design hides the machinery behind a
**three-concept** model.

## North star for this work
The everyday user sees only **three things**:
- **記憶 (Memory)** — a thing about you. Status = `確認待ち` (pending) or `承認済み` (approved). A simple
  **3-bucket** sensitivity badge (公開OK / 要確認 / 非公開).
- **接続 (Connection / an AI)** — one toggle per connection: 「自動で渡す（低感度のみ）／毎回確認」.
- **履歴 (History)** — what was shared with which AI, with one-tap revoke.

Everything else — candidate vs Fact wording, "Context Pack", `confidence`, `zero-touch`,
`standing delivery`, `approval mode`, the raw 5 tiers — is **hidden as everyday vocabulary** and revealed
only behind a 「詳細」 disclosure.

## Non-negotiable constraint
**The trust boundary is unchanged.** Approval is the trust gate; `secret_never_send` is never delivered.
Simplification is a vocabulary/presentation problem — it must not weaken the safety machinery hardened in
P0 (the allowlist gate, the dual-enforcement re-validation, the fail-safe migration).

## The 3-bucket sensitivity mapping (engine keeps 5 tiers; UI shows 3)
| UI bucket | Engine tiers | Meaning |
|---|---|---|
| **公開OK** | `public`, `personal` | auto-deliverable (zero-touch eligible) |
| **要確認** | `private_consequential`, `sensitive` | needs review before delivery |
| **非公開** | `secret_never_send` | never leaves the device |

`personal → 公開OK` matches the existing default `requiresApprovalAbove = "personal"` (≤ personal is
zero-touch eligible), so the buckets line up with the engine's current gate semantics — no gate change.

## Phasing
The user-visible "simple & easy" value comes almost entirely from the UI. So we ship the UI re-skin first
(low risk, engine untouched), and do the engine consolidation later as an internal cleanup with no
user-visible change.

### Phase 1 — UI re-skin (presentation-only, LOW RISK, engine unchanged)
No data-model / gate / classifier / migration changes. The engine keeps candidate/Fact, 5 tiers,
confidence, standing-delivery, approval modes — the UI is a simple skin over it.

Concrete transformations (the engine values are still there, just relabeled / bucketed / hidden):
1. **Unify candidate + Fact in the UI as 記憶 + status.** The 取り込み (Ingest) candidate list and the
   approved-fact surfaces present a single "記憶" concept with a status chip: `確認待ち` (← any candidate
   pending: new / needs_user_detail) or `承認済み` (← approved candidate / active Fact). The approve action
   reads as "この記憶を承認". (The engine still has separate candidate/Fact entities; the UI maps both to
   one list.)
2. **Sensitivity → 3 buckets.** Replace the 5-tier label map (App.tsx ~3712) usages in user-facing surfaces
   with the 3-bucket badge per the table above. Keep the raw tier visible only under 「詳細」.
3. **Hide `confidence` entirely** from everyday UI (it is an internal gate parameter). Show it only under
   「詳細」 if at all.
4. **Connection = one toggle.** Per connection, a single control 「自動で渡す（低感度のみ）／毎回確認」 mapping
   1:1 to the existing engine: ON ↔ `standingDeliveryEnabled = true` (`explicit_sensitive` mode); OFF ↔
   `always_review`. Hide the words "standing delivery" / "zero-touch" / "approval mode". The per-client
   confidence bar + `requiresApprovalAbove` live under 「詳細」 (default values are fine for most users).
5. **"Context Pack" → 「AIに渡した内容（記憶）」** in all user-facing strings (notices, the disclosure
   ledger, requests). The noun "Context Pack" disappears from everyday UI.
6. **「詳細」 disclosure** on the relevant surfaces reveals the real engine values (raw tier, confidence,
   approval mode, the per-client bar) for power users / debugging.

Phase 1 acceptance: a new user can connect, add context, approve, and understand "what AI knows / approve /
revoke" without ever encountering candidate / Fact / Context Pack / confidence / zero-touch / 5 tiers.
All existing tests still pass (presentation-only); `npm run product:check` green.

### Phase 2 — Engine consolidation (LATER, boundary-critical, no user-visible change)
Unify the engine entities candidate + Fact into a single **`Memory`** with a `status`:
- `needs_review` (← candidate new / needs_user_detail) — untrusted, NOT deliverable.
- `approved` (← approved candidate / active Fact) — canonical, deliverable.
- `blocked` (← blocked_sensitive / `secret_never_send`) — terminal, can never be approved.
- plus `superseded` / `rejected` / `archived` as needed (do not over-collapse — keep history/versioning).

The delivery gate keys on **`status === "approved"`** (replacing "it's an active Fact") — i.e. the P0
double-enforced boundary moves from entity-type to status, semantically identical. **Tiers stay 5;
`confidence` stays** (the allowlist gate still needs them — Phase 2 is entity-only).

Phase 2 requirements (mirror the P0 discipline):
- Dual core: change `src/vault.ts` and `src-tauri/src/lib.rs` `*_at_path` together.
- Projection: unify the `facts` / `memory_candidates` projection tables (or a derived `memories` view) +
  FTS; rebuild lazily.
- **Migration (fail-safe, durable, one-shot):** transform existing canonical `vault_state`
  `candidates[]` + `facts[]` into `memories[]` with status, **preserving approval state exactly** — an
  approved Fact ⇒ `approved`; a candidate ⇒ its mapped status; a secret ⇒ `blocked`. **Never elevate
  trust** (never auto-approve). Marker-guarded, writes back, rebuilds projection (the P0 migration pattern).
- **Re-run the full P0 boundary verification** against the status-based gate (the allowlist, dual
  enforcement, fail-closed, fire-once delivery) — treat it as boundary-relevant work.
- No user-visible change: the UI already shows the unified 記憶+status model from Phase 1.

## Out of scope (other improvement opportunities, deferred — separate threads)
Onboarding friction reduction and review-burden reduction were deprioritized because Q1 chose conceptual
overload as the single biggest barrier. They remain real opportunities for later.

## Self-review notes
- Trust preserved: Phase 1 is presentation-only (engine + boundary untouched); Phase 2 moves the gate to
  `status === approved` (semantically identical) with a fail-safe migration + full re-verification.
- Decisions captured: 3-concept model; personal → 公開OK; entity-only engine merge (tiers 5-engine/3-UI,
  confidence hidden); UI-first → engine-later sequencing; connection 1-toggle ↔ existing settings.
- No placeholders; the 3-bucket mapping and the status enum are concrete.
