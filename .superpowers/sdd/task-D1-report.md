# Task D1 Report — TimelineEmpty zero-facts onboarding branch

## Status

DONE

## What was changed

### `src/components/HomeTimeline.tsx`

`TimelineEmpty` now accepts a `state: VaultState` prop in addition to its existing
`scope`, `goSources`, and `goConnections` props.

When `state.facts.length === 0` (the vault has no approved facts yet), the component
renders an onboarding-style empty state instead of the scope-filtered "no activity
this week/month" message:

- **If pending candidates exist** (status ∈ `{"new", "needs_user_detail",
  "blocked_sensitive"}`): renders a primary "承認待ち N 件" button → `goSources`
- **Otherwise**: renders a primary "最初の文脈を追加" button → `goSources`

When `state.facts.length > 0` (the vault has facts, just none in the selected scope),
the original scope-filtered message is shown unchanged, with the same dual-CTA
"AIを接続する" / "情報を追加する" layout.

The call site in `HomeTimeline` was updated to pass `state={state}` to
`TimelineEmpty`.

Pending status detection uses a `Set<string>` to avoid the TypeScript
"not assignable to parameter of type" error that arises when using
`Array.prototype.includes` with a `const` tuple against a union-typed value:

```ts
const PENDING_STATUSES = new Set<string>(["new", "needs_user_detail", "blocked_sensitive"]);
const pendingCount = state.candidates.filter((c) =>
  PENDING_STATUSES.has(c.status),
).length;
```

### `src/components/HomeTimeline.test.tsx` (new file)

Three new Vitest tests using `renderToStaticMarkup` (matching the project's existing
`aiAccessUi.test.ts` pattern — no DOM environment needed):

| # | Scenario | Assertion |
|---|---|---|
| 1 | Zero facts, zero candidates | "最初の文脈を追加" present; scope-based heading absent |
| 2 | Zero facts, 3 pending candidates (new / needs_user_detail / blocked_sensitive) | "承認待ち" + "3" present; "最初の文脈を追加" absent |
| 3 | Zero facts, 3 non-pending candidates (approved / rejected / archived) | "最初の文脈を追加" present; "承認待ち" absent |

## i18n decision

**Inline JP literals** — matching the existing `HomeTimeline.tsx`/`TimelineEmpty`
style. `HomeTimeline.tsx` contains no `useTranslation` or i18n key references; all
user-facing strings are inline Japanese. Adding i18n keys here would have been
half-wiring (the existing strings would still be inline), so inline JP was the
correct match.

## Test result

```
Test Files  6 passed (6)
      Tests  71 passed (71)
```

## Build result

```
✓ tsc clean
✓ vite build — 373 kB JS bundle, no errors
```

## Scope compliance

- `HomeView` not removed (separate task D2)
- No Rust changes
- No `cargo fmt` run
- No i18n keys added (inline JP matched existing style)
- Both "最初の文脈を追加" and "承認待ち N 件" CTAs route via `goSources`

---

## Fix pass (Phase D1 spec-gap review)

### Changes made

**`src/components/HomeTimeline.tsx`**

1. Added `seedDemo: () => void` to `HomeTimelineProps`.
2. Hoisted `PENDING_STATUSES` to module scope (was recreated on every render inside `TimelineEmpty`).
3. `TimelineEmpty` now receives `factCount`, `pendingCandidateCount`, `seedDemo` as props instead of `state: VaultState` — counts are no longer recomputed inside `TimelineEmpty`.
4. `factCount` counts only `status === "active"` facts (was `state.facts.length` — raw array, which included superseded/deleted/etc.).
5. `pendingCandidateCount` computed via `useMemo` in `HomeTimeline`; `factCount` also via `useMemo`.
6. First-run branch now renders:
   - A trust line `<p className="qv-tl-empty__trust">承認した文脈だけがAIに渡ります。保存前にMemory Inboxで確認できます。</p>`
   - "デモで試す" quiet secondary button → `seedDemo` (alongside "最初の文脈を追加" primary)
7. Pending branch label changed from `"承認待ち {N} 件"` to `"承認待ち {N} 件を取り込みで確認"` (spec exact wording).

**`src/App.tsx`**

- Added `seedDemo={seedDemo}` to the `<HomeTimeline>` mount (~line 1821).

**`src/components/HomeTimeline.test.tsx`**

- Updated test (a): now asserts "デモで試す" present, "最初の文脈を追加" present, trust line present, scope-heading absent.
- Added test (c): vault with 1 active fact, no timeline entries → scope-empty message present; "最初の文脈を追加" and "デモで試す" absent.
- Added bonus test: vault with only superseded facts → first-run onboarding still shows (active-fact count is 0).

### Test result

```
Test Files  6 passed (6)
      Tests  73 passed (73)
```

### Build result

```
✓ tsc --noEmit clean
✓ vite build — 373 kB JS bundle, no errors
```
