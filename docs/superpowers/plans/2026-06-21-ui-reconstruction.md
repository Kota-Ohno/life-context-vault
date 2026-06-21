# UI Reconstruction — "Quiet Vault" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. UI work is verified by **build + screenshot-critique** (and unit tests where logic exists), not pure TDD. Each implementer task MUST invoke the **frontend-design** skill before writing UI, and screenshot the result against the canonical reference.

**Goal:** Replace the cramped, high-cognitive-load 8-section UI with a calm "Quiet Vault" design system and a 3-pillar shell whose Home is a disclosure-ledger timeline — eliminating layout breakage, flow complexity, and visual clutter.

**Architecture:** A bespoke design-token layer (CSS custom properties, light + dark via `[data-theme]`) and a small set of composable React components in `src/components/`, replacing ad-hoc styles in the single `src/App.tsx`. The 3-pillar IA from the prior redesign (文脈 / 取り込み / 接続) is the structure; this plan is its visual + interaction realization. The trust boundary stays the organizing visual principle (the timeline shows what crossed the boundary to which AI).

**Tech Stack:** React 19 + TypeScript + Vite; hand-written CSS with custom-property tokens (no Tailwind/CSS-in-JS); Google Fonts (Shippori Mincho / Zen Kaku Gothic New / IBM Plex Mono); lucide-react for icons; Tauri desktop shell (programmatic window, currently `"windows": []`).

**Canonical visual reference:** `docs/design/quiet-vault-home.html` (the approved Home reference; light + dark). Implementers port from it — exact tokens below are extracted from it. Screenshots: `docs/design/shots/qv-light.png`, `qv-dark.png`.

## Global Constraints

- Node 22; Rust stable. UI is **Japanese-first** (`index.html lang="ja"`); all copy in Japanese, end-user voice (name things by what people control; active voice; an action keeps its name through the flow).
- **Design tokens (verbatim — light):** `--paper:#F7F5F0` `--paper-rail:#F2EFE8` `--paper-raised:#FCFBF8` `--ink:#20201D` `--ink-soft:#6A675E` `--ink-faint:#9A968B` `--pine:#2E5A4E` `--pine-tint:#E6EDE9` `--brass:#A9803F` `--brass-tint:#F0E7D6` `--hairline:rgba(32,32,29,.10)` `--hairline-strong:rgba(32,32,29,.16)` `--radius:14px` `--radius-sm:9px`.
- **Design tokens (verbatim — dark `[data-theme=dark]`):** `--paper:#1A1916` `--paper-rail:#16150F` `--paper-raised:#232220` `--ink:#ECE8DF` `--ink-soft:#A7A399` `--ink-faint:#76726A` `--pine:#7FB29F` `--pine-tint:#1F2A26` `--brass:#CBA45E` `--brass-tint:#2A2417` `--hairline:rgba(236,232,223,.10)` `--hairline-strong:rgba(236,232,223,.18)`.
- **Type roles:** display/headings = `Shippori Mincho`; body = `Zen Kaku Gothic New`; data/utility (timestamps, sensitivity tiers, counts, IDs) = `IBM Plex Mono` with `tabular-nums`.
- **Accent discipline:** `pine` is the only standing accent. `brass` appears ONLY on disclosure/approval moments (the seal). No other accent colors.
- **Density:** low. One primary task per screen. Generous whitespace. Borders are hairlines; shadows are soft and rare.
- **Signature:** the disclosure **seal** (pine "✓ 自動で渡しました" / brass "! 承認待ち") + the `AIに渡った内容` boundary rule. Keep it the one memorable element; everything else quiet (Chanel rule: remove one accessory).
- **Quality floor (every screen):** responsive to the min window (960×640) down to a single column; visible keyboard focus (`:focus-visible` 2px pine outline); `prefers-reduced-motion` respected; light AND dark both verified.
- Icons: `lucide-react` (no emoji in production — the reference's emoji are placeholders).
- Do NOT change Rust/Vault-Core logic except where a task explicitly adds an IPC for a NEW UI affordance. The trust boundary and all `*_at_path` behavior are out of scope here.
- `src/App.tsx` is one ~8k-line file; this plan extracts from it. Keep each new component file focused. Mirror the existing `src/components/` primitive pattern.
- Verify with `npm run build` (tsc+vite) — NOT just `npm test`. (A prior plan's tsc break slipped because only vitest ran.) `cargo fmt`/full `product:check` fmt step is a known pre-existing repo-wide failure — out of scope.

---

## Design system spec (extracted from the reference)

**Components to build (Phase A), each light+dark, each a file in `src/components/`:**
- `Tokens` — a global stylesheet `src/styles/tokens.css` defining the two `:root`/`[data-theme=dark]` blocks above + base resets + the 3 font `@import`s (or `<link>` in `index.html`).
- `AppShell` — grid `248px 1fr`; `Rail` (left) + `<main>`. Collapses to single column under 880px.
- `Rail` — brand mark, `SearchField` (⌘K affordance), `RailNav` (3 destinations with active pine marker), foot (`VaultStatus` chip + theme toggle + settings).
- `ThemeToggle` — flips `document.documentElement.dataset.theme`; persists choice; defaults to OS (`prefers-color-scheme`).
- `Button` — variants: `primary` (pine), `ghost`, `quiet`; sizes sm/md.
- `Card` — `--paper-raised`, hairline, soft shadow, `--radius`.
- `Tag`/`Pill` — the fact pill (category in mono + value), `sealed` modifier (brass tint).
- `Seal` — the signature: circular brass/pine stamp (rotate -8°, inset highlight/shadow) + label + mono sub. Variants: `auto` (pine ✓), `pending` (brass !).
- `BoundaryRule` — the dashed `AIに渡った内容` divider.
- `Eyebrow`, `PageTitle` (Mincho), `Lede` — page header primitives.
- `SectionDivider` — the `今日 / 昨日` day rule.

**Type scale:** title 34/1.25 Mincho 600; section 15 Mincho 500; body 15/1.6; eyebrow 11.5 mono .14em uppercase; data 11.5 mono.

---

## Scope check → phases (each shippable; expand B–E into their own plan files when reached)

- **Phase A — Design system + AppShell** (this doc, detailed). Tokens, fonts, base components, the rail shell. Existing views are temporarily mounted inside the new shell so the app stays working. Ship first.
- **Phase B — Home = disclosure-ledger timeline.** Build the reference screen wired to real audit/delivery data: session grouping, fact pills, the seal (auto vs pending), revoke, approve-pending. Depends on A.
- **Phase C — Pillars 取り込み & 接続.** Redesign 取り込み (Sources + Inbox merged, bulk review) and 接続 (Connections + standing-delivery threshold from the prior plan) in the new system. Depends on A.
- **Phase D — First-run single-focus flow.** Empty-vault Home → one focused "最初の文脈を追加" path with progressive disclosure, replacing the 5-section cram. Depends on A, B.
- **Phase E — Window + polish.** Set Tauri window size/min (960×640) in Rust; swap emoji→lucide; responsive + a11y + reduced-motion audit across all screens; remove the legacy `index.css`.

> Phases B–E are outlined at the end. Expand each into its own `docs/superpowers/plans/…` file with task-level detail when you reach it.

---

## Phase A — Design system + AppShell

**What ships:** a new visual shell (rail + main) rendering in the Quiet Vault system with working light/dark, fonts, and base components; the existing 8 views temporarily mounted in `<main>` so nothing breaks. This de-risks the foundation before per-screen work.

### File structure
- Create: `src/styles/tokens.css` (tokens + resets), `index.html` font `<link>`s.
- Create: `src/components/AppShell.tsx`, `Rail.tsx`, `RailNav.tsx`, `SearchField.tsx`, `VaultStatus.tsx`, `ThemeToggle.tsx`, `Button.tsx`, `Card.tsx`, `Tag.tsx`, `Seal.tsx`, `BoundaryRule.tsx`, `PageHeader.tsx` (Eyebrow/PageTitle/Lede), `SectionDivider.tsx`. Co-locate each component's CSS (`<Name>.css`) or extend `tokens.css` utility layer — match the existing `src/components/` convention (inspect it first).
- Modify: `src/App.tsx` — wrap the view switch in `<AppShell>`; replace the current sidebar with `<Rail>`; map the 8 nav items down to the 3 destinations (文脈 → Home/timeline+search; 取り込み → Sources+Inbox; 接続 → Connections), with Requests/Audit folding into 文脈 later (Phase B) — for Phase A, keep all existing views reachable via a temporary "more" affordance so nothing is lost.
- Add dependency: `lucide-react` (check it isn't already present).

### Interfaces
- `AppShell({ rail, children })`, `Rail({ active, onNavigate })` with destinations `"context" | "intake" | "connections"`, `ThemeToggle()` (self-contained), `Button({variant,size,...})`, `Card`, `Tag({category, sealed?}>`, `Seal({variant:"auto"|"pending", label, detail})`.

### Tasks

**Task A1 — Tokens + fonts + theme toggle.** Create `src/styles/tokens.css` with both token blocks (verbatim above) + base resets + font-family vars; add the 3 Google-Fonts `<link>`s to `index.html`; build `ThemeToggle` (sets `data-theme`, persists to localStorage, defaults to `prefers-color-scheme`). Verify: a throwaway page renders both themes; `prefers-reduced-motion` disables transitions. Screenshot light+dark. Commit.

**Task A2 — Base components.** `Button`, `Card`, `Tag`, `Seal`, `BoundaryRule`, `PageHeader`, `SectionDivider`, `SearchField`, `VaultStatus` — port styles from `docs/design/quiet-vault-home.html` exactly (token-driven, no hard-coded hex). Build a `src/components/_gallery.tsx` (dev-only) rendering each in both themes; screenshot-critique against the reference. Commit.

**Task A3 — Rail + AppShell.** `Rail` (brand, SearchField, RailNav with pine active marker, foot with VaultStatus + ThemeToggle + settings), `AppShell` grid, responsive collapse <880px. lucide icons. Screenshot vs reference rail. Commit.

**Task A4 — Mount existing views in the shell.** In `App.tsx`, render the new `AppShell`/`Rail`; route the 3 destinations; temporarily host the existing view components inside `<main>` (unstyled-by-new-system is OK for now — they get redesigned in B/C). Ensure every current view is still reachable and the app builds. `npm run build` + `npm test` green; screenshot the app running the new shell with an existing view inside. Commit.

### Task detail — A1 (representative; B–E expand similarly)

**Files:** Create `src/styles/tokens.css`; Modify `index.html`; Create `src/components/ThemeToggle.tsx`.

- [ ] **Step 1 — Invoke the frontend-design skill** (read its guidance; it governs all UI tasks in this plan).
- [ ] **Step 2 — Create `src/styles/tokens.css`** with the two token blocks from Global Constraints verbatim, `*{box-sizing}`, body base (`background:var(--paper);color:var(--ink);font-family` body var), the `@media (prefers-reduced-motion:no-preference)` transition rule, `:focus-visible{outline:2px solid var(--pine);outline-offset:2px}`, and font-family custom props `--font-display:"Shippori Mincho",serif; --font-body:"Zen Kaku Gothic New",system-ui,sans-serif; --font-mono:"IBM Plex Mono",ui-monospace,monospace`. Import it in `src/main.tsx` (or App entry).
- [ ] **Step 3 — Add fonts** to `index.html` `<head>`: the preconnect + the Google Fonts `<link>` for `Shippori+Mincho:wght@500;600;700`, `Zen+Kaku+Gothic+New:wght@400;500;700`, `IBM+Plex+Mono:wght@400;500`.
- [ ] **Step 4 — Build `ThemeToggle.tsx`:** reads initial theme from `localStorage` ?? `matchMedia('(prefers-color-scheme: dark)')`; sets `document.documentElement.dataset.theme`; a `Button`-styled control labelled "表示" with a lucide `Contrast`/`Moon` icon; persists on change.
- [ ] **Step 5 — Verify:** `npm run build` passes; open the app, toggle theme, confirm both render and persist across reload; confirm reduced-motion kills transitions (DevTools emulate). Take light+dark screenshots; eyeball against `docs/design/shots/`.
- [ ] **Step 6 — Commit:** `git add src/styles/tokens.css index.html src/components/ThemeToggle.tsx src/main.tsx && git commit -m "feat(ui): Quiet Vault design tokens, fonts, and theme toggle"`

### Phase A acceptance
- App renders inside the new rail+main shell, both themes, fonts loaded, base components match the reference, every existing view still reachable, `npm run build` + `npm test` green. No screen looks broken at the 960px min width.

---

## Phase B — Home = disclosure-ledger timeline (OUTLINE)
- **B1 Data:** pure selector `buildActivityTimeline(state)` → session groups `{client, day, time, task, facts[], disclosure: "auto"|"pending", sensitivityTier}` from audit/delivery + context-pack events. Unit-tested.
- **B2 Screen:** port the reference Home (PageHeader, scope chips 今週/今月/すべて, day dividers, `Entry` cards with client glyph, task in Mincho, `BoundaryRule`, fact `Tag`s, `Seal`). Wire to B1. Screenshot vs reference.
- **B3 Actions:** `取り消す` (revoke a delivered fact for a client → existing fact-hide/policy path) and pending `今回だけ`/`今後このAIに自動` (one-shot vs promote threshold — depends on the standing-delivery work; if Plan-2 promotion isn't built yet, wire `今後自動` to the existing standing-delivery toggle and stub `今回だけ`). Audited. Unit-tested.
- **B4** Empty state hands off to Phase D.

## Phase C — Pillars 取り込み & 接続 (OUTLINE)
- **C1 取り込み:** Sources list + candidate review merged; group candidates by source; bulk approve/reject; inline edit — in the new system. (Logic from the prior candidate-review plan if present.)
- **C2 接続:** Connections list with per-connection threshold + the standing-delivery toggle (already shipped) restyled into the new `Card`/`Seal` language; show what each connection may receive.

## Phase D — First-run single-focus flow (OUTLINE)
- **D1** Empty-vault Home = one calm focused action ("最初の文脈を追加") + progressive-disclosure guided steps, replacing the 5-section cram. Once ≥1 fact exists, Home becomes the B timeline.

## Phase E — Window + polish (OUTLINE)
- **E1** Set the Tauri window in Rust: default ~1200×800, **min 960×640**, resizable.
- **E2** Replace all emoji placeholders with lucide icons; final responsive + `:focus-visible` + `prefers-reduced-motion` + light/dark audit on every screen; delete the legacy `src/index.css` once nothing references it.

---

## Self-review
- **Spec coverage:** scope/shell/aesthetic/first-run/light-dark/window decisions all map (A→tokens+shell+light/dark; B→timeline Home; C→pillars; D→first-run; E→window+polish). Icons (lucide), JP-first copy, accent discipline, density, signature all in Global Constraints.
- **No placeholders that matter:** exact token hex, font names, type scale, and component list are embedded; the canonical reference HTML carries the rest. B–E are explicitly outlines to expand, not fake-detailed.
- **Consistency:** token names identical to the reference; `Seal` variants `auto`/`pending` used identically in A (component) and B (Home). Destinations `context|intake|connections` consistent across Rail and App routing.
- **Boundary:** no Vault-Core/retrieval logic changed except Phase E's window config and any explicitly-added IPC for revoke/approve in B3 (which reuse existing core paths).
