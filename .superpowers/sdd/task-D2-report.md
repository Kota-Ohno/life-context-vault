# Task D2 Report — Remove dead legacy HomeView (Phase D2)

## Symbols deleted

### `src/App.tsx`
| Symbol | Type | Lines removed |
|---|---|---|
| `backgroundSetupBody` | import from `./vault` | 112 |
| `createBackgroundSource` | import from `./vault` | 117 |
| `BackgroundSetupInput` | import from `./types` | 146 |
| `OnboardingStep` | local type declaration | 250–257 |
| `HomeNextActionKind` | local type declaration | 259–265 |
| `blankSetup` | module-level const | 390–396 |
| `const [setup, setSetup]` | useState in App component | 440 |
| `submitBackground` | async function in App component | 796–818 |
| `HomeView` | exported function component | 2034–2346 |
| `SetupForm` | function component | 2348–2372 |
| `homeNextActionKind` | exported function | 4223–4245 |

Total lines removed from App.tsx: 420 lines (5460 → 5040).

### `src/aiAccessUi.test.ts`
| Symbol | Reason |
|---|---|
| `homeNextActionKind` import (line 15) | function deleted |
| `HomeView` import (line 16) | component deleted |
| `describe("homeNextActionKind", ...)` block (lines 692–743) | 5 unit tests for deleted function |
| `it("sends first-time Home onboarding ...")` test (lines 802–833) | test for deleted component; onboarding now covered by HomeTimeline.test.tsx |

Total lines removed from aiAccessUi.test.ts: 88 lines (860 → 772).

## Symbols KEPT (live references confirmed)

| Symbol | Where still referenced | Notes |
|---|---|---|
| `BackgroundSetupInput` (type in `types.ts`) | `vault.ts:6`, `vault.ts:290`, `vault.ts:305` | Only the App.tsx import was removed; the type itself stays in types.ts |
| `backgroundSetupBody` (fn in `vault.ts`) | Used internally by `vault.ts:307` (`createBackgroundSource`) | Only the App.tsx import was removed |
| `createBackgroundSource` (fn in `vault.ts`) | Used internally by `vault.ts:2289` (`seedDemo` path) | Only the App.tsx import was removed |
| `seedDemo` | `HomeTimeline` (live Home), App.tsx (~line 3451 after edits) | Explicitly listed as out-of-scope; untouched |
| `homeAiBoundarySections` | App.tsx (still referenced), `aiAccessUi.test.ts` (tests kept) | Not in dead code; kept entirely |
| `HomeTimeline` | Live home view; all its tests | Not touched |

## Bonus rename
In `src/components/HomeTimeline.test.tsx` line 144, renamed the test title from:
> `"does NOT show onboarding when vault has only superseded facts (not counted as active)"`
to:
> `"still shows onboarding when vault has only superseded facts (superseded ≠ active)"`

This matches the assertions (the test verifies onboarding DOES show, because superseded ≠ active).

## Build output
```
npm run build
> tsc && vite build
✓ 1732 modules transformed.
dist/assets/index-I-2WB7SN.js   373.58 kB │ gzip: 110.84 kB
✓ built in 735ms
```
tsc --noEmit: clean (no errors).

## Test output
```
npm test
> vitest run

 Test Files  6 passed (6)
      Tests  71 passed (71)
   Duration  478ms
```
All 71 tests pass.
