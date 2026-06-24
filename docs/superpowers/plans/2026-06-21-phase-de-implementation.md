# Phase D + E2 — Implementation Plan (Quiet Vault UI reconstruction, final phases)

> Executes against the approved design in this session. Parent roadmap:
> `docs/superpowers/plans/2026-06-21-ui-reconstruction.md` (Phases A–E).
> A, B merged (PR#4). C (取り込み + 接続) and E1 (window min 960×640) shipped on `feat/ui-phase-cde`.
> This plan finishes **Phase D** (first-run onboarding) and **Phase E2** (polish).
> REQUIRED SUB-SKILL: superpowers:subagent-driven-development, task-by-task with TDD.

## Global constraints (inherited)
- React 19 + TS + Vite. `src/App.tsx` is one ~8k-line file, no router — grep, don't navigate.
- UI is Japanese-first (`index.html lang="ja"`); copy lives in `src/i18n/ja.ts` + `en.ts`.
- Trust boundary unchanged: Phase D/E2 are presentational + view-routing only. No `*_at_path`,
  no Rust core logic, no retrieval/policy changes. Still run `npm run product:check` before done.
- Do NOT run `cargo fmt` (no rustfmt.toml; 2-space tree). Match surrounding style by hand.
- Canonical predicates (reuse verbatim for consistency with the Inbox badge):
  - pending candidate: `["new","needs_user_detail","blocked_sensitive"].includes(c.status)`
  - active/deliverable fact: `f.status === "active"`

---

## Phase D — First-run single-focus onboarding

**Design:** the empty-vault Home becomes a single-focus path, not the legacy 5-section grid.
Today `TimelineEmpty` (src/components/HomeTimeline.tsx) fires on **scope-empty**
(`days.length === 0`), so a vault that *has* facts but no deliveries this week wrongly reads as
first-run. Fix: branch on **real vault content**.

`HomeTimeline` already receives `state: VaultState`. Derive two counts and pass them — plus a new
`seedDemo` callback (exists at App.tsx:1772 → `makeDemoVault()`; also used at App.tsx:3871, so it
survives D2) — into `TimelineEmpty`.

Three branches:
| Condition | Surface |
|---|---|
| ① first-run `facts=0 ∧ pending=0` | single focus: primary CTA 「最初の文脈を追加」→ `goSources()`; quiet secondary 「デモで試す」→ `seedDemo()`; one-line trust framing (承認した文脈だけがAIへ／保存前にInboxで確認). |
| ② pending `facts=0 ∧ pending>0` | 「承認待ち {N} 件を取り込みで確認」→ `goSources()`. |
| ③ scope-empty `facts>0` | keep current light "この期間の記録はまだありません" message — NOT onboarding. |

### Task D1 — TimelineEmpty 3-branch (TDD)
- **Test first** (`src/components/HomeTimeline.test.tsx`, create if absent; else colocated test):
  render `HomeTimeline` (or `TimelineEmpty` if unit-testable) with three `state` fixtures:
  (a) 0 facts/0 candidates → asserts 「最初の文脈を追加」 + 「デモで試す」 present, demo click calls `seedDemo`;
  (b) 0 facts/2 pending candidates → asserts 「承認待ち 2 件」 copy + `goSources` wired, no onboarding CTA;
  (c) 1 active fact, scope=week, no deliveries → asserts the light scope-empty message, no onboarding CTA.
- **Implement:**
  - `HomeTimelineProps`: add `seedDemo: () => void`.
  - In `HomeTimeline`, compute `factCount` / `pendingCandidateCount` from `state` (memoized).
  - `TimelineEmpty` gains props `{ factCount, pendingCandidateCount, seedDemo }` and branches as above.
  - Wire mount at App.tsx:1821 to pass `seedDemo`.
- **i18n:** add keys under an `homeEmpty.*` (or extend `onboarding.*`) namespace in `ja.ts` AND `en.ts`.
- Style: reuse existing empty-state CSS classes; keep accent discipline (single primary action).

### Task D2 — delete dead legacy HomeView (blocked by D1)
- `HomeView` (App.tsx:2033) has no JSX call site (HomeTimeline owns Home since Phase B); it is the
  "5-section cram" the design replaces. Remove the component + any now-unused helpers it solely used.
- `seedDemo` stays (App.tsx:3871). Repoint or drop `HomeView` references in `src/aiAccessUi.test.ts`
  (import + `createElement(HomeView, …)`); keep the assertions' intent by retargeting to the live
  surface, or delete the obsolete case. Mirror the InboxView removal in C2 (ef29b27).
- Verify no dangling imports / unused props after removal (`npm run build` = tsc --noEmit).

### Phase D acceptance
- `npm test` green incl. new branch tests; `npm run build` clean.
- Empty vault shows single-focus onboarding; pending-only shows review CTA; populated shows timeline.
- Device spot-check in `npm run tauri:dev` (empty vault + after seedDemo).

---

## Phase E2 — Polish (E1 already shipped: window min 960×640)

### Task E2a — emoji → lucide icons
- Inventory emoji used as UI affordances across `src/App.tsx` + `src/components/*`.
- Replace with `lucide-react` icons (already a dep — verify in package.json; if absent, add).
- Keep aria-labels; decorative icons get `aria-hidden`. Don't replace emoji inside user content/copy.

### Task E2b — a11y + reduced-motion + light/dark audit
- focus-visible rings on all interactive elements (rail, CTAs, toggles, list rows).
- `@media (prefers-reduced-motion: reduce)` neutralizes transitions/animations introduced in A–D.
- Re-verify light AND dark for the new D empty states and any E2a icon swaps.
- Keyboard reachability of the new onboarding CTAs.

### Task E2c — remove legacy `src/index.css`
- Confirm the Quiet Vault token/system CSS fully supersedes `src/index.css`; grep its import.
- Remove the file and its import; verify no visual regression (build + device spot-check).

### Phase E2 acceptance
- No emoji affordances remain (icons are lucide); reduced-motion honored; focus rings everywhere;
  legacy `index.css` gone; light/dark both clean.

---

## Done-gate (whole branch)
- `npm run product:check` passes (tests, build, cargo fmt --check, cargo test, bins, relay smoke,
  hosted-relay, git diff --check).
- Resolve orphaned untracked `src/lib/formatVaultError.ts` (+test): wire into the C2 ingest error
  path if intended, else delete. Decide during D2/E2c cleanup.
- Device-verify, then open PR `feat/ui-phase-cde` → `master` (finishing-a-development-branch).
