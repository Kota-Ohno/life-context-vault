# Improvement Sweep (post-Phase-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Complete every confirmed improvement found by the 8-lens multi-agent discovery (and any that emerge), so the app fully conforms to the product philosophy — maximally simple, minimal user effort, trust boundary intact — with no remaining everyday-surface machine vocabulary, no dead weight, and a near-zero-effort first run.

**Architecture:** Presentation/UX + dead-code removal. The engine (`src/vault.ts`, `src-tauri/src/lib.rs`) — gate, classifier, pack build/retrieval, migration — stays behaviorally unchanged. New work is hardcoded Japanese copy (the app is `lang="ja"` JP-first), removal of unused code, accessible-styling fixes, additive onboarding UI, and an opt-in batch-approval UX that routes per-item through the existing `approveCandidate` (preserving per-candidate deliberateness + audit + secret rejection).

**Tech Stack:** React 19 + TS + Vite (`src/`); Vitest. Rust untouched (verify with `git diff --name-only` → 0 `.rs`).

**Source of truth:** `.superpowers/sdd/discovery-findings.json` (17 confirmed findings, both rounds) + the known-deferred vocabulary list. Philosophy: `CLAUDE.md`.

## Global Constraints

- **Boundary + scope discipline are non-negotiable.** Only user-APPROVED facts reach AI; `secret_never_send` never leaves; ingestion stays curated (no passive mass-capture). No task may add a capture surface, weaken the gate, or make an irreversible delivery one-tap without confirmation. If a task seems to require an engine change, STOP and escalate.
- **Presentation-only for engine:** 0 `.rs`/Cargo files changed across this plan. Verify per task.
- **JP-first, in-place copy.** New user-facing strings are Japanese, matching the surrounding file's literal-string style. Vocabulary standard (everyday surface): 記憶 / 接続 / 履歴; 公開OK・要確認・非公開; 確認待ち・承認済み・対象外; 「AIに渡した内容（記憶）」; 取り込み (ingest); 取り込み元 (source); 変換ツール (provider); 監査ログ (audit). Machine terms (Source/Provider/Capture/Pack/Context Pack/confidence/raw 5 tiers/English status/English nav) must not appear on an everyday surface — only inside a `<DetailsDisclosure>` or as code identifiers.
- **All existing tests stay green.** Update a test assertion only when it pins a string/label you deliberately changed (display-only); never weaken a structural/boundary assertion (esp. in `aiAccessUi.test.ts`).
- **Each task ends green:** `npm test` + `npm run build` pass; the final task runs full `npm run product:check`.
- **Don't break the trust-boundary tests** (`aiAccessUi.test.ts`): the "approved fact text must not appear in receipt" and exclusion-count assertions stay intact.

## File Structure

- New: `src/onboarding.ts` (or `.tsx`) — salvaged + updated first-run/onboarding copy constants (replaces the dead i18n onboarding catalog).
- Modify: `src/App.tsx` (nav label map, dead state removal, onboarding wiring, batch-approval state, vocab), `src/views/IngestView.tsx` (vocab, batch-approval UI, candidate recovery), `src/views/ConnectView.tsx` (onboarding/status copy), `src/components/SensitivityBadge.tsx` (a11y), `src/styles.css` (contrast, batch UI, legacy CSS removal), `src/i18n/*` (delete dead layer), tests as needed.

---

## Task 1: Dead-weight removal (不要なものの除去)

**Files:** `src/App.tsx`, `src/i18n/*` (delete), `src/components/NavButton.tsx` (verify/delete), `src/styles.css`, plus a new `src/onboarding.ts` to salvage onboarding copy.

**Interfaces — Produces:** `src/onboarding.ts` exporting the onboarding step copy used by Task 5.

- [ ] **Step 1 — confirm what is truly dead (grep before deleting):**
  Run each and record consumers:
  - i18n: `grep -rn "from \"./i18n\"\|from \"../i18n\"\|i18n/index\|\bt(\|detectLang\|\bLang\b" src` — confirm `t()` has 0 call sites and `detectLang`/`Lang` have no non-i18n consumers. (If any are used, keep only those; do not break a real caller.)
  - capture state: for each of `captureClient, captureConversationId, captureText, captureExtensionId, captureHostInstallBusy, captureHostInstallResult, confirmAllCapturePurge` (App.tsx:406-413), grep its setter + value usage. Remove ONLY those with no remaining JSX/logic consumer. (The `browser_capture` connection KIND is in-scope and stays — do not remove connection-kind handling, only the dead capture-host install/compose residue.)
  - `grep -rn "NavButton" src` — if only its own file defines it and nothing imports it, it is dead.
  - unused lucide icons: after other edits, `npm run build` surfaces `TS6133` unused-import errors; remove those imports.
- [ ] **Step 2 — salvage onboarding copy:** before deleting `src/i18n/ja.ts`, copy its `onboarding.*` strings into a new `src/onboarding.ts` as plain exported constants (you will improve them in Task 5). Example shape:
  ```ts
  // src/onboarding.ts — first-run guidance copy (salvaged from the removed i18n layer)
  export const ONBOARDING_STEPS = [
    { key: "add", title: "記憶を追加", body: "生活の文脈を書くか、ファイルを取り込みます。" },
    { key: "approve", title: "確認して承認", body: "取り込みで内容を確認し、AIに渡してよい記憶だけ承認します。" },
    { key: "connect", title: "AIと接続", body: "AIクライアントを接続し、要求が来たら確認して返します。" },
  ] as const;
  ```
- [ ] **Step 3 — delete the dead i18n layer:** remove `src/i18n/ja.ts`, `src/i18n/en.ts`, `src/i18n/index.ts`, `src/i18n/index.test.ts` (and the `i18n` dir), and the now-unused App.tsx import (`import { detectLang, Lang, t } from "./i18n"` or similar). Remove any dead `lang` state that only fed `t`.
- [ ] **Step 4 — remove confirmed dead capture state** (only the ones Step 1 proved unused) and their now-dead handlers/JSX.
- [ ] **Step 5 — delete `NavButton.tsx`** if Step 1 proved it dead.
- [ ] **Step 6 — remove the orphaned legacy CSS** `.sensitivity.public`, `.sensitivity.personal`, `.sensitivity.private_consequential`, `.sensitivity.sensitive`, `.sensitivity.secret_never_send` rules in `src/styles.css` (superseded by `.sensitivity.bucket-*`; the badge no longer emits raw-tier classes — confirm with `grep -n "bucket-\|sensitivity " src/components/SensitivityBadge.tsx`). Also remove the dark-theme override that targeted those tier classes if now-orphaned.
- [ ] **Step 7 — verify:** `npm test` (all green), `npm run build` (no unused-symbol errors), `git diff --name-only | grep -c '\.rs$'` → 0.
- [ ] **Step 8 — commit:** `chore(ui): remove dead i18n layer, capture-host residue, NavButton, legacy tier CSS`.

---

## Task 2: Accessibility fixes

**Files:** `src/styles.css`, `src/components/SensitivityBadge.tsx`.

- [ ] **Step 1 — failing check (manual, record before):** the `.qv-search` placeholder uses `color: var(--ink-faint)` on `--paper` → measured 2.71:1 (light) / 3.67:1 (dark), both fail WCAG AA 4.5:1 for normal text. `.qv-search:hover` already uses `--ink-soft`/`--ink-secondary` which passes (5.19:1 / 6.98:1).
- [ ] **Step 2 — fix contrast:** change the default `.qv-search` (and its placeholder span) text color from `--ink-faint` to `--ink-secondary` (= `--ink-soft`), keeping the hover state. Verify both themes resolve ≥ 4.5:1. Do not lower any other token.
- [ ] **Step 3 — badge SR name:** in `SensitivityBadge.tsx`, the badge text is the bucket label (SR-readable already); add `aria-label` is NOT needed if the visible text suffices — instead ensure the `title` (raw tier) is supplemental only. If the badge is used purely as an icon-like chip anywhere without adjacent text, add an `aria-label` with the bucket label. (Confirm via grep that the badge always renders visible text; if so, no change beyond a comment.)
- [ ] **Step 4 — verify:** `npm test`, `npm run build` green.
- [ ] **Step 5 — commit:** `fix(a11y): raise search-field contrast to WCAG AA in light+dark`.

---

## Task 3: Vocabulary — navigation + global labels

**Files:** `src/App.tsx`.

- [ ] **Step 1 — nav/view label map:** at App.tsx ~4566-4571 the label map has English values. Rebrand to Japanese consistent with the 3-concept model:
  - `home → "ホーム"` (or keep existing), `sources → "取り込み"`, `search → "検索"`, `audit → "監査ログ"`, `settings → "設定"`, plus any `inbox → "取り込み"` / `requests → "AI要求"` / `connections → "接続"` entries. (Map each existing key; do not rename the KEYS, only the display values.)
- [ ] **Step 2 — stray English labels:** fix rendered English like `<Metric label="Audit" ...>` (App.tsx:2683 → "監査") and any `"Standing Delivery"`, `"payload"`, `"delivery"`, `"Inbox"` everyday-surface strings. Leave code identifiers, classNames, and `<DetailsDisclosure>` contents.
- [ ] **Step 3 — mixed EN/JP error/notice strings** on everyday surfaces: normalize to Japanese (do NOT touch `formatVaultError` internal Rust-exception fallbacks — those are the accepted low-visibility class).
- [ ] **Step 4 — verify + update any pinned test assertion** (display-only). `npm test`, `npm run build` green.
- [ ] **Step 5 — commit:** `feat(ui): Japanese navigation + global labels (監査ログ/取り込み/設定/…)`.

---

## Task 4: Vocabulary — Ingest/Connect surfaces (Source/Provider/Capture/Pack)

**Files:** `src/views/IngestView.tsx`, `src/views/ConnectView.tsx`, `src/App.tsx` (the cited pack/capture lines).

- [ ] **Step 1 — sweep:** `grep -rnE "Source|Provider|Capture|Pack|Raw|Context Pack|Context Request" src/views/*.tsx src/App.tsx` and classify each hit as code/className/comment/`詳細` (leave) vs everyday-surface Japanese string (rebrand). Cited everyday-surface hits: IngestView.tsx:91,97,271,280,457,458,460,487; App.tsx:615,1260,2260,3830,3944,3966-3971,4315,4570-4571.
- [ ] **Step 2 — rebrand** everyday-surface strings using the standard: `Source` → 取り込み元; `Raw Source` → 取り込み元の原文; `Provider` → 変換ツール (OCR/Office 変換); `Source化` → 取り込み; `AI会話Capture` → AI会話の取り込み; `Context Pack`/`Pack` (user-facing) → AIに渡した内容（記憶）/その一部; `Context Request` → AI要求. Keep JSX expressions, classNames, handlers, and provider-detail text inside `<DetailsDisclosure>` intact.
- [ ] **Step 3 — leak gate:** re-grep; confirm zero everyday-surface `Source|Provider|Capture|Context Pack|Pack|Raw` remain outside `<DetailsDisclosure>`/code. List any deliberately-left with reason.
- [ ] **Step 4 — verify + update pinned test assertions** (display-only). `npm test`, `npm run build` green.
- [ ] **Step 5 — commit:** `feat(ui): Japanese vocabulary for ingest/connect surfaces (取り込み元/変換ツール/…)`.

---

## Task 5: Onboarding & first-run availability (足りないもの)

**Files:** `src/App.tsx`, `src/views/ConnectView.tsx`, new content from `src/onboarding.ts` (Task 1), `src/styles.css`.

**Interfaces — Consumes:** `ONBOARDING_STEPS` from `src/onboarding.ts`.

- [ ] **Step 1 — first-run 3-step card:** in the empty-vault state (`HomeTimeline` `TimelineEmpty`, factCount===0), render the sequenced workflow from `ONBOARDING_STEPS`: 記憶を追加 → 確認して承認 → AIと接続（要求を確認して返す）. Icon + one line each, in order. Keep the existing CTAs (最初の文脈を追加 / デモで試す).
- [ ] **Step 2 — empty-inbox next-step guidance:** the empty AI-requests/Inbox state (App.tsx ~2137) currently says only "まだAI要求はありません". Add persistent, discoverable next-step copy: 「Claude Desktopを再起動し、何か質問してみてください。要求はここに表示されます。MCPを使わない場合は下で『AIに渡す内容（記憶）』を作成できます。」 Pure copy — do NOT add a synthetic "test request".
- [ ] **Step 3 — persistent connection status:** if a lightweight connection/installed indicator is feasible from existing state (e.g. `connectorSessions`/installed config), show a small "接続済み / 未接続" status near the Connect surface so the user gets feedback after setup. Use only existing state; no new IPC/engine call. If no such state exists without engine work, SKIP and note it (do not add engine work).
- [ ] **Step 4 — mark manual config as last-resort** in ConnectView copy (the one-click install is primary; the manual MCP template is the fallback).
- [ ] **Step 5 — verify:** `npm test`, `npm run build` green; visually confirm in `npm run dev` (light+dark) the onboarding card and inbox guidance render.
- [ ] **Step 6 — commit:** `feat(ui): first-run 3-step onboarding + empty-inbox next-step guidance + connection status`.

---

## Task 6: User-effort — opt-in batch approval + candidate recovery

**Files:** `src/views/IngestView.tsx`, `src/App.tsx`, `src/styles.css`.

**Interfaces — Consumes:** the existing `approve(candidate)` handler (App.tsx:1151) → per-item `approveCandidate` (vault.ts:579, which already hard-rejects `secret_never_send`).

- [ ] **Step 1 — opt-in multi-select:** add a selection mode to the candidate list. When on, each candidate card shows a checkbox; a header action 「選択した記憶を承認」 approves the selected set by calling the EXISTING per-item approve once per selected candidate (preserving per-candidate classification, audit, supersession, and the secret_never_send rejection). Require ONE final confirmation showing the count (e.g. 「5件の記憶を承認します」). Each selected item remains an explicit user choice — do NOT auto-select or auto-approve.
  - Boundary rule: never bypass `approveCandidate`; never batch-approve a `blocked_sensitive`/secret candidate (exclude them from selection or let the per-item call reject them and report the skipped count).
- [ ] **Step 2 — (optional, low) candidate recovery:** add a collapsed 「却下・あとで」 section listing archived/rejected candidates with a 「戻す」 action that sets status back to a pending state via the existing status-change handler. If this needs an engine change, SKIP and note it.
- [ ] **Step 3 — tests:** add a Vitest test for the pure selection/eligibility logic if you extract one (e.g. "secret/blocked candidates are not batch-approvable"); otherwise assert the approve handler is called once per selected id. Keep it non-vacuous.
- [ ] **Step 4 — verify:** `npm test`, `npm run build` green; `git diff --name-only | grep -c '\.rs$'` → 0.
- [ ] **Step 5 — commit:** `feat(ui): opt-in batch approval (select-then-approve, per-item, one confirmation)`.

---

## Task 7: Release gate + re-discovery loop

**Files:** none (verification).

- [ ] **Step 1 — full gate:** `npm run product:check` (do NOT pipe through `tail`); success = `Product release checks passed`.
- [ ] **Step 2 — leak sweep:** `grep -rnE "Source|Provider|Capture|Context Pack|\bPack\b|confidence|Standing Delivery|Audit|Inbox|Settings|Requests|Later|Sensitive" src/App.tsx src/views/*.tsx src/components/*.tsx` — every hit must be code/className/comment/`詳細`-contents. List residuals with justification.
- [ ] **Step 3 — re-run discovery:** the controller re-runs the 8-lens discovery workflow against the new tree. Any new confirmed medium+ finding becomes a follow-up task; loop until discovery returns no new confirmed medium+ items (the acceptance criterion).
- [ ] **Step 4 — commit** any sweep fixes; final ledger entry.

---

## Self-Review

**Spec coverage (discovery findings → tasks):**
- Dead i18n layer / capture residue / NavButton / legacy CSS / unused icons → T1. ✅
- Search contrast AA fail / badge SR → T2. ✅
- English nav labels / Standing Delivery / mixed EN-JP → T3. ✅
- Source/Provider/Capture/Pack/Context-Pack rebrand → T4. ✅
- Empty-inbox guidance / first-run 3-step / connection status / manual-config-last-resort → T5. ✅
- Batch approval / candidate recovery → T6. ✅
- Boundary lens: 0 confirmed (boundary sound) — re-verified by the release gate + T7 re-discovery. ✅
- Acceptance loop (until multi-agent finds nothing) → T7. ✅

**Boundary safety:** every task presentation/UX/dead-code only; 0 `.rs` files; batch approval routes per-item through the existing gated `approveCandidate`; no capture surface added; no irreversible one-tap. ✅

**Placeholder scan:** removals are gated on "grep proves zero consumers" before deleting; optional items (T5 status, T6 recovery) have explicit SKIP-if-needs-engine clauses. No vague "handle edge cases". ✅

**Type/naming consistency:** `ONBOARDING_STEPS` (T1) consumed in T5; nav label KEYS unchanged (values only) in T3; batch approval reuses `approve`/`approveCandidate` names from existing code in T6. ✅
