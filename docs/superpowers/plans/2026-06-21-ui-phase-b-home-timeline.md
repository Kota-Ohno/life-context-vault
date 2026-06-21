# UI Phase B — Home = Disclosure-Ledger Timeline (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. UI verified by build + screenshot-critique; the data selector by unit tests (TDD). Each UI task invokes the **frontend-design** skill and screenshots against the reference.

**Goal:** Replace the cramped `HomeView` with the disclosure-ledger timeline from the approved reference — "which AI saw what, and why" — assembled from the Quiet Vault components (Phase A), wired to real Context-Pack data, with per-entry revoke and pending-approve.

**Architecture:** A pure selector `buildActivityTimeline(state)` derives session-grouped timeline data from `contextPacks` + `contextPackRequests` + `facts`; a `HomeTimeline` screen renders it with the A2 components (`PageHeader`, `Chip`, `SectionDivider`, `Card`, `BoundaryRule`, `Tag`, `Seal`, `Button`). Actions reuse existing core functions (`confirmContextPack`, standing-delivery setter, fact hide). No Vault-Core/retrieval logic changes.

**Tech Stack:** React 19 + TS; the Phase A `qv-` components + tokens; `src/vault.ts` (selector lives near other pure selectors) + `src/vault.test.ts` (tests).

**Canonical reference:** `docs/design/quiet-vault-home.html` (the timeline = `.day`, `.entry`, `.entry.pending`, `.boundary`, `.facts/.fact`, `.seal`, `.scoperow/.chip`). Base branch: continues `feat/ui-quiet-vault` (Phase A merged into it).

## Global Constraints
- Reuse Phase A tokens + `qv-` components; no new hard-coded hex; Japanese-first, end-user voice.
- Verify with `npm run build` (tsc+vite) AND `npm test`; screenshot light+dark.
- Do NOT change `src-tauri/`, retrieval-time boundary, or i18n keys' meaning. New copy in the timeline is fine.
- Data model (verbatim, from `src/types.ts`):
  - `ContextPack { id, requestId?, taskText, generatedAt, expiresAt?, maxSensitivityIncluded, items: ContextPackItem[], confirmationStatus: "not_required"|"pending_user_confirmation"|"confirmed"|"edited_by_user"|"cancelled", confirmedAt? }`
  - `ContextPackRequest { id, clientId, clientName, taskText, purpose, createdAt, expiresAt, status }`
  - `ContextPackItem { factId, itemText, reasonIncluded, sensitivity, sourceTitles[] }`
  - `ApprovedFact { id, domain, factText, sensitivity, … }` (join by `item.factId` for the category/domain label)

---

## Task B1 — `buildActivityTimeline` selector (pure, TDD)

**Files:** Modify `src/vault.ts` (add the selector + exported types near other selectors); Test `src/vault.test.ts`.

**Produces (exact contract — B2 consumes this):**
```ts
export type TimelineDisclosure = "auto" | "pending" | "confirmed" | "cancelled";
export type TimelineFact = { factId: string; text: string; category: string; sensitivity: SensitivityTier };
export type TimelineEntry = {
  packId: string;
  requestId?: string;
  clientId: string;
  clientName: string;
  task: string;
  at: string;                 // ISO; confirmedAt ?? generatedAt
  disclosure: TimelineDisclosure;
  maxSensitivity: SensitivityTier;
  facts: TimelineFact[];
};
export type TimelineDay = { dayKey: string; label: string; entries: TimelineEntry[] }; // label: 今日/昨日/M月D日
export function buildActivityTimeline(state: VaultState, opts?: { scope?: "week"|"month"|"all" }): TimelineDay[];
```
**Logic:**
- For each `pack` in `state.contextPacks`: resolve the request via `state.contextPackRequests.find(r => r.id === pack.requestId)` → `clientId`, `clientName`, `task` (request.taskText ?? pack.taskText), `createdAt`.
- `disclosure`: `not_required`→`"auto"`; `confirmed`/`edited_by_user`→`"confirmed"`; `pending_user_confirmation`→`"pending"`; `cancelled`→`"cancelled"`.
- `facts`: `pack.items.map(it => ({ factId: it.factId, text: it.itemText, sensitivity: it.sensitivity, category: domainLabel(state.facts.find(f=>f.id===it.factId)?.domain) }))` — reuse the existing `domainLabel`/category helper in vault.ts (grep for it; the app already maps domains to Japanese labels).
- `at` = `pack.confirmedAt ?? pack.generatedAt`.
- Group by day (local date of `at`); `label` = 今日/昨日/`M月D日`. Sort days desc, entries within a day desc by `at`.
- `scope` filter on `at` (week = last 7 days, etc.); default `"week"`.
- Exclude nothing by default (cancelled entries still show, marked). A pack with no resolvable request still shows (clientName fallback "不明なクライアント").

**Steps (TDD):**
- [ ] Write failing tests in `vault.test.ts`: build a state with 2 packs (one `not_required` ChatGPT today, one `pending_user_confirmation` Claude today) + their requests + facts; assert `buildActivityTimeline` returns 1 day ("今日") with 2 entries, correct `disclosure` (`auto`/`pending`), `facts` with category labels, newest-first. Add a scope test (an old pack excluded under `"week"`). Add an empty-state test (`[]`).
- [ ] Run → fail. Implement the selector. Run → pass. `npm test` green.
- [ ] Commit: `feat(ui): buildActivityTimeline selector for the Home disclosure ledger`.

## Task B2 — Home timeline screen

**Files:** Create `src/components/HomeTimeline.tsx` (+ any sub-pieces like `TimelineEntry.tsx`); Modify `src/App.tsx` (render `<HomeTimeline/>` for `view==="home"` instead of the old `HomeView`; keep old `HomeView` importable but unused, or behind the first-run check from Phase D later). CSS in `src/styles.css` (`qv-` prefixed; most comes from A2 components — the timeline mainly composes them).

**Build:** Port the reference Home body: `PageHeader` (eyebrow ホーム·アクティビティ / title「AIが見たあなたの文脈」/ lede), scope `Chip`s (今週/今月/すべて driving `buildActivityTimeline` scope state), per day a `SectionDivider`, per entry a `Card` (tone `pending` when disclosure==="pending") containing: head (client glyph + name + mono time), task in Mincho, `BoundaryRule` (label "AIに渡った内容" for auto/confirmed, "承認すると渡る内容" for pending), the `Tag` fact pills (sealed when pending), and the `Seal` footer (`auto`→pine「自動で渡しました」+ mono detail tier; `pending`→brass「あなたの承認待ち」) with the action controls (B3). Empty state: a single calm placeholder (Phase D replaces with the real first-run) — for B2, a quiet "まだAIに渡した文脈はありません" with a hint.

**Verify:** `npm run build`+`npm test` green; `npm run dev` — Home renders the timeline from demo/seeded data in light AND dark; matches the reference (Mincho title, day dividers, pending card brass edge, fact pills, Seal). Screenshot both themes. Empty vault shows the calm placeholder, not a broken grid. Commit: `feat(ui): Home disclosure-ledger timeline screen`.

## Task B3 — Revoke + pending-approve actions

**Files:** Modify `src/components/HomeTimeline.tsx`/`TimelineEntry.tsx`, `src/App.tsx` (handlers), possibly `src/vault.ts` (a thin `revokeDeliveredFactForEntry` if needed). Reuse existing core fns — grep for them: `confirmContextPack`, the standing-delivery setter (`setNativeConnectionStandingDelivery`/`updateAccessPolicy({standingDeliveryEnabled})` from the prior plan), and the fact-hide path (`updateFactStatus`/hide → `user_hidden`).

**Wire:**
- **pending entry** → `今回だけ`: `confirmContextPack(state, packId)` then re-check deliverability (mirror the existing approve flow in App.tsx); `今後このAIに自動`: enable standing delivery for `entry.clientId` (existing setter) THEN confirm. Both audited by the core. On the native path use the native IPC; browser path the pure-TS fns.
- **auto/confirmed entry** → `取り消す`: hide the disclosed fact so it won't be delivered again (`updateFactStatus(factId,"user_hidden")` or the existing hide fn), behind a small confirm ("このFactを今後どのAIにも渡さない"); record audit. (Deeper per-client-only revocation is deferred to Plan 2 / Phase C — note this in the UI copy: it stops delivery to ALL AIs.)
- After any action, re-derive the timeline (state update) so the entry reflects the new status.

**Verify:** unit-test the new `vault.ts` helper if added; `npm run build`+`npm test`; `npm run dev` — approve a pending entry (it moves to confirmed/auto), revoke a delivered fact (it disappears from future packs). Screenshot. Commit: `feat(ui): timeline revoke + pending-approve actions`.

## Task B4 — Empty-state handoff stub
- For B2 the empty state is a calm placeholder. Phase D replaces it with the full single-focus first-run. No separate task here unless B2's placeholder needs splitting — fold into B2.

## Self-review
- B1 contract (`TimelineDay[]`) is consumed verbatim by B2; `disclosure` values consistent across B1/B2/B3. Reuses existing `domainLabel`, `confirmContextPack`, standing-delivery setter, fact-hide — no new core logic. Reference HTML governs visuals. No `src-tauri`/retrieval/i18n-meaning changes.
