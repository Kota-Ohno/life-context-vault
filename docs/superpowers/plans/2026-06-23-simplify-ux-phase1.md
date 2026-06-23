# Simplify UX — Phase 1 (UI Re-skin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the UI so an everyday user sees only **記憶 (Memory) / 接続 (Connection) / 履歴 (History)** — hiding candidate-vs-Fact wording, "Context Pack", `confidence`, standing-delivery/approval-mode jargon, and the raw 5 sensitivity tiers behind a 3-bucket badge + a 「詳細」 disclosure.

**Architecture:** Presentation-only. The engine — data model, allowlist gate, classifier, migration, the dual TS/Rust core, the trust boundary — is **untouched**. We add two pure UI mapping modules (`src/sensitivityBuckets.ts`, `src/memoryStatus.ts`), re-point the display chokepoints (`SensitivityBadge`, the IngestView candidate card, the fact rows, the connection/standing-delivery panel) at them, and rename user-facing "Context Pack" copy. The 5 engine tiers, `confidence`, `standingDeliveryEnabled`/`requiresApprovalAbove`, and the candidate/Fact entities all still exist — the UI is a skin over them.

**Tech Stack:** React 19 + TypeScript + Vite (`src/`); Vitest. No Rust changes expected (see Global Constraints — parity guard).

**Source of truth:** `docs/superpowers/specs/2026-06-23-simplify-ux-design.md` (Phase 1 section). Approved by user 2026-06-23 ("いいね GO").

## Global Constraints

- **Presentation-only. NO engine change.** Do not touch: the data model (`MemoryCandidate`/`ApprovedFact` shapes, `CandidateStatus`/`FactStatus` unions, `SensitivityTier`), the allowlist gate, `classifySensitivity`, the migration, pack build/retrieval (`buildContextPackForRequest`, `ensure_context_pack_allowed_by_current_policy`, `safe_context_pack_for_client`), or `setStandingDelivery`/`requiresApprovalAbove` semantics. If a task seems to require an engine change, STOP and escalate — it belongs in Phase 2.
- **The 3-bucket mapping is fixed (spec table):** `public`,`personal` → **公開OK**; `private_consequential`,`sensitive` → **要確認**; `secret_never_send` → **非公開**. Copy these exact labels verbatim.
- **The 5-tier `sensitivityLabel` STAYS** for the sensitivity editor `<select>` (the user must still be able to pick a specific tier) and under 「詳細」. Do NOT rewrite or delete `sensitivityLabel`.
- **記憶 status vocabulary (spec):** a pending candidate (`new`/`needs_user_detail`) shows **確認待ち**; an approved candidate (`approved`/`edited_and_approved`) or an active Fact (`active`) shows **承認済み**; `secret_never_send`/`blocked_sensitive` shows **非公開**. Approve action reads **「この記憶を承認」**.
- **"Context Pack" → 「AIに渡した内容（記憶）」** in user-facing strings ONLY. Do **not** rename code symbols, function names, identifiers, type names, IPC command names, or comments (`buildContextPackForRequest`, `confirmContextPack`, `createNativeContextPackRequest`, CSS class names like `qv-standing-row`, etc. stay exactly as they are).
- **Rust parity guard:** for every user-facing Japanese string you change inside `src/vault.ts`, grep `src-tauri/src/lib.rs` for the *old* string. If it exists there, mirror the change in Rust (and run `cargo fmt`). If it does not, no Rust change. Most changes are in `.tsx` files and need no mirror.
- **All existing tests must pass.** Where a test asserts an old display string (the tier label, a "Context Pack" string), update the assertion to the new copy — that is expected for a re-skin; do not change non-display logic to make a test pass.
- **Dark mode + tokens:** new UI uses existing CSS custom-property tokens (the codebase migrated fully to tokens in #6). No raw hex colors; reuse existing `badge`/`qv-*` class patterns.
- **i18n:** the app is Japanese-first (`index.html lang="ja"`). New strings are Japanese. `src/i18n/ja.ts` / `en.ts` exist — if a string you touch is already routed through i18n keys, update the keys; otherwise match the surrounding literal-string style of the file you are in.

## File Structure

- `src/sensitivityBuckets.ts` — **NEW.** Pure 5-tier→3-bucket mapping (`sensitivityBucketKey`, `sensitivityBucketLabel`, bucket type). No React, no engine import beyond the `SensitivityTier` type.
- `src/sensitivityBuckets.test.ts` — **NEW.** Unit tests for the mapping.
- `src/memoryStatus.ts` — **NEW.** Pure candidate/fact status → 記憶-status mapping (`candidateMemoryStatus`, `factMemoryStatus`, `memoryStatusLabel`).
- `src/memoryStatus.test.ts` — **NEW.** Unit tests for the status mapping.
- `src/components/SensitivityBadge.tsx` — **MODIFY.** Render the 3-bucket label; keep raw tier in `title`.
- `src/components/DetailsDisclosure.tsx` — **NEW.** Reusable native-`<details>` 「詳細」 wrapper.
- `src/views/IngestView.tsx` — **MODIFY.** Candidate card → 記憶+status vocabulary; hide `confidence`; "Context Pack" copy; raw values under 詳細.
- `src/App.tsx` — **MODIFY.** Fact rows (status chip, hide confidence); connection/standing-delivery panel → one toggle + 詳細; "Context Pack" copy; read-only sensitivity summaries → bucket label.
- `src/views/ConnectView.tsx` — **MODIFY.** "Context Pack" copy.
- `src/vault.ts` — **MODIFY (display strings only).** Read-only sensitivity summary text → bucket label; "Context Pack" copy in receipt/summary builders (with Rust parity guard).
- `src/aiAccessUi.test.ts` — **MODIFY.** Update assertions that pin changed display strings.

---

## Task 1: Pure 5→3 sensitivity-bucket mapping

**Files:**
- Create: `src/sensitivityBuckets.ts`
- Test: `src/sensitivityBuckets.test.ts`

**Interfaces:**
- Consumes: `SensitivityTier` from `src/types.ts` (`"public" | "personal" | "private_consequential" | "sensitive" | "secret_never_send"`).
- Produces:
  - `type SensitivityBucket = "public_ok" | "needs_review" | "private"`
  - `sensitivityBucketKey(tier: SensitivityTier): SensitivityBucket`
  - `sensitivityBucketLabel(tier: SensitivityTier): string` (returns 公開OK / 要確認 / 非公開)

- [ ] **Step 1: Write the failing test**

```ts
// src/sensitivityBuckets.test.ts
import { describe, it, expect } from "vitest";
import { sensitivityBucketKey, sensitivityBucketLabel } from "./sensitivityBuckets";

describe("sensitivityBuckets", () => {
  it("maps public and personal to 公開OK", () => {
    expect(sensitivityBucketLabel("public")).toBe("公開OK");
    expect(sensitivityBucketLabel("personal")).toBe("公開OK");
    expect(sensitivityBucketKey("public")).toBe("public_ok");
    expect(sensitivityBucketKey("personal")).toBe("public_ok");
  });
  it("maps private_consequential and sensitive to 要確認", () => {
    expect(sensitivityBucketLabel("private_consequential")).toBe("要確認");
    expect(sensitivityBucketLabel("sensitive")).toBe("要確認");
    expect(sensitivityBucketKey("sensitive")).toBe("needs_review");
  });
  it("maps secret_never_send to 非公開", () => {
    expect(sensitivityBucketLabel("secret_never_send")).toBe("非公開");
    expect(sensitivityBucketKey("secret_never_send")).toBe("private");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sensitivityBuckets.test.ts`
Expected: FAIL — cannot find module `./sensitivityBuckets`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/sensitivityBuckets.ts
import type { SensitivityTier } from "./types";

// UI-only collapse of the engine's 5 sensitivity tiers into the 3 buckets the
// everyday user sees. The engine keeps all 5 tiers; this is presentation only.
export type SensitivityBucket = "public_ok" | "needs_review" | "private";

export function sensitivityBucketKey(tier: SensitivityTier): SensitivityBucket {
  switch (tier) {
    case "public":
    case "personal":
      return "public_ok";
    case "private_consequential":
    case "sensitive":
      return "needs_review";
    case "secret_never_send":
      return "private";
  }
}

const BUCKET_LABELS: Record<SensitivityBucket, string> = {
  public_ok: "公開OK",
  needs_review: "要確認",
  private: "非公開",
};

export function sensitivityBucketLabel(tier: SensitivityTier): string {
  return BUCKET_LABELS[sensitivityBucketKey(tier)];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sensitivityBuckets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sensitivityBuckets.ts src/sensitivityBuckets.test.ts
git commit -m "feat(ui): pure 5-tier→3-bucket sensitivity mapping helper"
```

---

## Task 2: Pure candidate/fact → 記憶-status mapping

**Files:**
- Create: `src/memoryStatus.ts`
- Test: `src/memoryStatus.test.ts`

**Interfaces:**
- Consumes: `CandidateStatus` and `FactStatus` from `src/types.ts`.
  - `CandidateStatus = "new" | "needs_user_detail" | "approved" | "edited_and_approved" | "rejected" | "archived" | "blocked_sensitive"`
  - `FactStatus = "active" | "superseded" | "expired" | "needs_review" | "user_hidden" | "deleted"`
- Produces:
  - `type MemoryStatusKey = "pending" | "approved" | "blocked" | "superseded" | "expired" | "hidden" | "removed" | "rejected"`
  - `candidateMemoryStatus(s: CandidateStatus): MemoryStatusKey`
  - `factMemoryStatus(s: FactStatus): MemoryStatusKey`
  - `memoryStatusLabel(key: MemoryStatusKey): string`

- [ ] **Step 1: Write the failing test**

```ts
// src/memoryStatus.test.ts
import { describe, it, expect } from "vitest";
import { candidateMemoryStatus, factMemoryStatus, memoryStatusLabel } from "./memoryStatus";

describe("memoryStatus", () => {
  it("treats pending candidates as 確認待ち", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("new"))).toBe("確認待ち");
    expect(memoryStatusLabel(candidateMemoryStatus("needs_user_detail"))).toBe("確認待ち");
  });
  it("treats approved candidates as 承認済み", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("approved"))).toBe("承認済み");
    expect(memoryStatusLabel(candidateMemoryStatus("edited_and_approved"))).toBe("承認済み");
  });
  it("treats blocked candidates as 非公開", () => {
    expect(memoryStatusLabel(candidateMemoryStatus("blocked_sensitive"))).toBe("非公開");
  });
  it("treats an active fact as 承認済み and needs_review as 確認待ち", () => {
    expect(memoryStatusLabel(factMemoryStatus("active"))).toBe("承認済み");
    expect(memoryStatusLabel(factMemoryStatus("needs_review"))).toBe("確認待ち");
  });
  it("maps fact lifecycle states to history labels", () => {
    expect(memoryStatusLabel(factMemoryStatus("superseded"))).toBe("置き換え済み");
    expect(memoryStatusLabel(factMemoryStatus("expired"))).toBe("期限切れ");
    expect(memoryStatusLabel(factMemoryStatus("user_hidden"))).toBe("非表示");
    expect(memoryStatusLabel(factMemoryStatus("deleted"))).toBe("削除済み");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/memoryStatus.test.ts`
Expected: FAIL — cannot find module `./memoryStatus`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/memoryStatus.ts
import type { CandidateStatus, FactStatus } from "./types";

// UI-only unification: candidate and Fact are one "記憶" concept to the user,
// distinguished by a status chip. The engine keeps them as separate entities.
export type MemoryStatusKey =
  | "pending"
  | "approved"
  | "blocked"
  | "superseded"
  | "expired"
  | "hidden"
  | "removed"
  | "rejected";

export function candidateMemoryStatus(s: CandidateStatus): MemoryStatusKey {
  switch (s) {
    case "new":
    case "needs_user_detail":
      return "pending";
    case "approved":
    case "edited_and_approved":
      return "approved";
    case "blocked_sensitive":
      return "blocked";
    case "rejected":
      return "rejected";
    case "archived":
      return "removed";
  }
}

export function factMemoryStatus(s: FactStatus): MemoryStatusKey {
  switch (s) {
    case "active":
      return "approved";
    case "needs_review":
      return "pending";
    case "superseded":
      return "superseded";
    case "expired":
      return "expired";
    case "user_hidden":
      return "hidden";
    case "deleted":
      return "removed";
  }
}

const STATUS_LABELS: Record<MemoryStatusKey, string> = {
  pending: "確認待ち",
  approved: "承認済み",
  blocked: "非公開",
  superseded: "置き換え済み",
  expired: "期限切れ",
  hidden: "非表示",
  removed: "削除済み",
  rejected: "却下",
};

export function memoryStatusLabel(key: MemoryStatusKey): string {
  return STATUS_LABELS[key];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/memoryStatus.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memoryStatus.ts src/memoryStatus.test.ts
git commit -m "feat(ui): pure candidate/fact → 記憶-status mapping helper"
```

---

## Task 3: 3-bucket SensitivityBadge + 「詳細」 disclosure component

**Files:**
- Modify: `src/components/SensitivityBadge.tsx`
- Create: `src/components/DetailsDisclosure.tsx`

**Interfaces:**
- Consumes: `sensitivityBucketKey`, `sensitivityBucketLabel` (Task 1); `sensitivityLabel` from `src/vault.ts` (unchanged).
- Produces: `<DetailsDisclosure summary="詳細">…</DetailsDisclosure>` — a reusable collapsible used by later tasks.

- [ ] **Step 1: Modify SensitivityBadge to render the bucket label, keep raw tier in `title`**

Replace the entire body of `src/components/SensitivityBadge.tsx` with:

```tsx
import type { SensitivityTier } from "../types";
import { sensitivityLabel } from "../vault";
import { sensitivityBucketKey, sensitivityBucketLabel } from "../sensitivityBuckets";

// Everyday UI shows the 3-bucket label; the raw 5-tier label stays reachable
// via the native tooltip (title) as the minimal 「詳細」 affordance.
export function SensitivityBadge({ sensitivity }: { sensitivity: SensitivityTier }) {
  return (
    <span
      className={`badge sensitivity bucket-${sensitivityBucketKey(sensitivity)}`}
      title={sensitivityLabel(sensitivity)}
    >
      {sensitivityBucketLabel(sensitivity)}
    </span>
  );
}
```

Note: the old `${sensitivity}` className is replaced by `bucket-${key}`; if any CSS rule keyed off `.sensitivity.public` etc. existed, it is presentation styling only — add/adjust `.badge.sensitivity.bucket-public_ok|needs_review|private` rules in the same stylesheet if the badges lose their color (verify visually in Task 6). Reuse existing badge tone tokens; no raw hex.

- [ ] **Step 2: Create the DetailsDisclosure component**

```tsx
// src/components/DetailsDisclosure.tsx
import type { ReactNode } from "react";

// Native <details> disclosure for power-user / debugging values (raw tier,
// confidence, approval mode, per-client bar). Hidden by default; no JS state.
export function DetailsDisclosure({
  summary = "詳細",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="qv-details">
      <summary className="qv-details__summary">{summary}</summary>
      <div className="qv-details__body">{children}</div>
    </details>
  );
}
```

- [ ] **Step 3: Run the full test suite to verify no regression**

Run: `npm test`
Expected: PASS — except possibly assertions in `src/aiAccessUi.test.ts` that pin the old tier label via a badge-derived string. If any fail because a summary now reads a bucket label, that is handled in Task 5 (vault.ts summaries) — note them and continue. SensitivityBadge is a pure component with no direct unit test, so this step is a guard, not a red test.

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS (tsc --noEmit + vite build).

- [ ] **Step 5: Commit**

```bash
git add src/components/SensitivityBadge.tsx src/components/DetailsDisclosure.tsx
git commit -m "feat(ui): 3-bucket SensitivityBadge + reusable 詳細 disclosure"
```

---

## Task 4: IngestView — candidate card → 記憶+status, hide confidence, copy

**Files:**
- Modify: `src/views/IngestView.tsx`

**Interfaces:**
- Consumes: `candidateMemoryStatus`, `memoryStatusLabel` (Task 2); `SensitivityBadge` (Task 3, already bucketed).

This task is presentation copy + chip changes on the candidate card. Anchor by string, not line number (lines shift).

- [ ] **Step 1: Add imports** at the top of `src/views/IngestView.tsx` (with the other `../` imports):

```tsx
import { candidateMemoryStatus, memoryStatusLabel } from "../memoryStatus";
```

- [ ] **Step 2: Replace the candidate `confidence` span with a 記憶-status chip**

Find:

```tsx
                  <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
                  <span className="qv-ingest__cand-conf">{candidate.confidence}</span>
```

Replace with (drop confidence from everyday view; show the 記憶 status chip instead):

```tsx
                  <SensitivityBadge sensitivity={candidate.detectedSensitivity} />
                  <span className="qv-ingest__cand-status">
                    {memoryStatusLabel(candidateMemoryStatus(candidate.status))}
                  </span>
```

- [ ] **Step 3: Rename the approve action to 「この記憶を承認」**

Find the candidate primary action button:

```tsx
                  <Button variant="primary" size="sm" onClick={() => approve(candidate)}>
                    <Check size={14} />
```

Ensure its visible label reads `この記憶を承認` (replace the adjacent text node — e.g. `承認` / `保存` — with `この記憶を承認`). If the button text is on the next line, change only the human-readable label, not the handler.

- [ ] **Step 4: Replace "Context Pack" / candidate / Fact wording in IngestView copy**

Apply these literal copy replacements (user-facing strings only — leave handlers/classes untouched):

| Find (substring) | Replace with |
|---|---|
| `候補は承認後にFactになり、Context Pack確認後だけAIに渡ります。` | `記憶は承認後にAIへ渡せるようになり、確認後だけAIに渡ります。` |
| `古いFactを置き換える場合だけ選択します。置き換えたFactはContext Packから外れ、履歴に残ります。` | `古い記憶を置き換える場合だけ選択します。置き換えた記憶はAIに渡らなくなり、履歴に残ります。` |
| `センシティブ候補です。保存するとContext Pack使用時に確認対象になります。` | `要確認の記憶です。保存するとAIに渡す前に毎回確認します。` |
| `ここで保存されるのはSourceと未承認候補です。AIへ渡るのは承認したFactから作るContext Packだけです。` | `ここで保存されるのは取り込み元と未承認の記憶です。AIへ渡るのは承認した記憶だけです。` |
| `保存すると未承認候補を再生成します。既存のApprovedFactは再確認待ちになり、関連Context Packは無効化されます。` | `保存すると未承認の記憶を作り直します。承認済みの記憶は再確認待ちになり、AIに渡した内容（記憶）は無効化されます。` |
| `関連Context Pack {linkedPackCount}件に影響します。` | `AIに渡した内容（記憶）{linkedPackCount}件に影響します。` |

(The last row: keep the `{linkedPackCount}` JSX expression exactly; only the surrounding Japanese literal changes.)

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test && npm run build`
Expected: PASS. If a Vitest test asserts one of the replaced IngestView strings, update the assertion to the new copy (display-only).

- [ ] **Step 6: Commit**

```bash
git add src/views/IngestView.tsx
git commit -m "feat(ui): IngestView 記憶+status vocabulary; hide confidence; AIに渡した内容 copy"
```

---

## Task 5: vault.ts + App.tsx fact rows — bucket summaries, status chip, hide confidence, copy

**Files:**
- Modify: `src/vault.ts` (display strings only)
- Modify: `src/App.tsx`
- Modify: `src/aiAccessUi.test.ts` (assertion updates)

**Interfaces:**
- Consumes: `sensitivityBucketLabel` (Task 1); `factMemoryStatus`, `memoryStatusLabel` (Task 2).

- [ ] **Step 1: Find every user-facing sensitivity/Context-Pack display string in vault.ts**

Run: `grep -nE "sensitivityLabel|Context Pack|コンテキストパック" src/vault.ts`
For each hit, classify: is it a **read-only display summary** (e.g. `sensitivitySummary`, a receipt `detail` string, a standing-delivery note) or the **editor `<select>` / internal logic**? Only read-only display summaries get changed. The `sensitivityLabel` function definition itself is NOT changed.

- [ ] **Step 2: Switch read-only sensitivity summaries to the bucket label**

Add to the imports at the top of `src/vault.ts`:

```ts
import { sensitivityBucketLabel } from "./sensitivityBuckets";
```

In the read-only summary builders, replace `sensitivityLabel(<tier expr>)` with `sensitivityBucketLabel(<tier expr>)`. The known sites (verify by grep — lines shift):
- the `sensitivitySummary` field (currently `highestSensitivity ? sensitivityLabel(highestSensitivity) : "空のVault"`) → use `sensitivityBucketLabel`.
- the receipt/preview detail that reads `最高感度は${sensitivityLabel(pack.maxSensitivityIncluded)}です。` → `最高感度は${sensitivityBucketLabel(pack.maxSensitivityIncluded)}です。`

Do NOT change `sensitivityLabel` usages that feed the editor `<select>` options or any policy/threshold *logic*.

- [ ] **Step 3: Replace "Context Pack" copy in vault.ts receipt/summary builders**

Replace user-facing `Context Pack` substrings in receipt/summary text with `AIに渡した内容（記憶）` (e.g. a summary body containing `Context Pack確認` → `AIに渡した内容（記憶）の確認`). Leave all identifiers/types/comments unchanged.

- [ ] **Step 4: Rust parity guard**

For each Japanese string you changed in Steps 2–3, run e.g.:
`grep -n "最高感度は" src-tauri/src/lib.rs` and `grep -n "Context Pack" src-tauri/src/lib.rs`
- If the old string exists in `lib.rs`, apply the same replacement there and run `cargo fmt --manifest-path src-tauri/Cargo.toml`.
- If it does not exist, no Rust change. Record in the report which strings had a Rust mirror and which did not.

- [ ] **Step 5: Fact rows in App.tsx — status chip + hide confidence**

Add to App.tsx imports:

```tsx
import { factMemoryStatus, memoryStatusLabel } from "./memoryStatus";
```

Find the read-only fact meta line:

```tsx
            <strong>{fact.factText}</strong>
            <span>{domainLabel(fact.domain)} / {fact.confidence} / {factStatusLabel(fact.status)}</span>
```

Replace with (drop `confidence` from everyday view; use the 記憶 status label):

```tsx
            <strong>{fact.factText}</strong>
            <span>{domainLabel(fact.domain)} / {memoryStatusLabel(factMemoryStatus(fact.status))}</span>
```

If `factStatusLabel` becomes unused after this, remove its now-dead definition/import only if nothing else references it (grep first); otherwise leave it.

- [ ] **Step 6: Move the raw fact values under 「詳細」**

Immediately after the replaced fact meta `<span>` (still inside the read-only branch), add a disclosure exposing the hidden engine values:

```tsx
            <DetailsDisclosure>
              <span>感度: {sensitivityLabel(fact.sensitivity)} / 確信度: {fact.confidence} / 状態: {factStatusLabel(fact.status)}</span>
            </DetailsDisclosure>
```

Add `import { DetailsDisclosure } from "./components/DetailsDisclosure";` to App.tsx. (If `factStatusLabel` is referenced here, keep it.)

- [ ] **Step 7: Update aiAccessUi.test.ts assertions**

Run: `npx vitest run src/aiAccessUi.test.ts` — for each failure caused by a changed display string, update the expected value to the new copy:
- a summary asserting the tier label `センシティブ` for a `sensitive` pack → expect `要確認`.
- a detail asserting `送信禁止` for `secret_never_send` → expect `非公開`.
- a body asserting `Context Pack確認` → expect `AIに渡した内容（記憶）の確認`.
Only update assertions whose change is purely the display string; do not weaken structural/logic assertions.

- [ ] **Step 8: Run tests + typecheck**

Run: `npm test && npm run build`
Expected: PASS. Also run `cargo test --manifest-path src-tauri/Cargo.toml` if Step 4 changed any Rust string.

- [ ] **Step 9: Commit**

```bash
git add src/vault.ts src/App.tsx src/aiAccessUi.test.ts src-tauri/src/lib.rs 2>/dev/null
git commit -m "feat(ui): bucket summaries + fact 記憶-status chip; hide confidence behind 詳細; AIに渡した内容 copy"
```

---

## Task 6: Connection one-toggle + ConnectView copy

**Files:**
- Modify: `src/App.tsx` (standing-delivery panel)
- Modify: `src/views/ConnectView.tsx`

**Interfaces:**
- Consumes: `setStandingDelivery(clientId, checked)` (unchanged engine call); `DetailsDisclosure` (Task 3); existing `Toggle`.

- [ ] **Step 1: Re-label the standing-delivery panel as one plain-language toggle**

In the connection/standing-delivery block in `App.tsx` (anchor: `SectionDivider label="自動配信 Standing Delivery"`):
- Change the divider label `自動配信 Standing Delivery` → `AIに自動で渡す`.
- Move the per-policy `thresholdLabel` (the `public より上は確認` text) OUT of the always-visible `qv-standing-row__threshold` line and INTO a `<DetailsDisclosure>` below the toggle. The always-visible row shows only the connection name + the one toggle.
- Set the toggle's visible/`label` text to the plain-language pair: `自動で渡す（低感度のみ）／毎回確認`.

Concretely, replace the `qv-standing-row` render with:

```tsx
                    return (
                      <div key={policy.clientId} className="qv-standing-row">
                        <div className="qv-standing-row__info">
                          <p className="qv-standing-row__name">{displayName}</p>
                        </div>
                        <Toggle
                          id={`standing-${policy.clientId}`}
                          checked={policy.standingDeliveryEnabled === true}
                          onChange={(checked) => setStandingDelivery(policy.clientId, checked)}
                          label={`${displayName}：自動で渡す（低感度のみ）／毎回確認`}
                        />
                        <DetailsDisclosure>
                          <span>確認のしきい値: {thresholdLabel}</span>
                        </DetailsDisclosure>
                      </div>
                    );
```

Add `import { DetailsDisclosure } from "./components/DetailsDisclosure";` to App.tsx if Task 5 did not already.

- [ ] **Step 2: Update the standing-delivery note copy**

Find:

```tsx
                  <p className="qv-standing-note">
                    有効にすると、この接続の閾値以下のContext PackはAIへ自動で返されます。閾値を超えるPackは引き続きあなたの確認が必要です。
```

Replace the Japanese literal with:

```tsx
                  <p className="qv-standing-note">
                    オンにすると、低感度の記憶はAIへ自動で渡します。要確認の記憶は引き続きあなたの確認が必要です。
```

- [ ] **Step 3: Replace "Context Pack" copy in ConnectView**

| Find (substring) | Replace with |
|---|---|
| `AIクライアントを接続すると、あなたが審査・承認した情報だけをContext Packとして渡します。金庫の中身がそのまま渡されることはありません。` | `AIクライアントを接続すると、あなたが審査・承認した記憶だけを渡します。金庫の中身がそのまま渡されることはありません。` |
| `Claude Desktopの設定ファイルにMCPサーバーを追加します。接続後、Claude DesktopからContext Packを要求できます。毎回の要求はあなたの確認を経てから返されます。` | `Claude Desktopの設定ファイルにMCPサーバーを追加します。接続後、Claude Desktopから記憶を要求できます。毎回の要求はあなたの確認を経てから返されます。` |
| `MCPを使わず、RequestsでContext Packを作成してコピーし、ChatGPTやClaudeなど任意のAIに貼り付けられます。設定は不要です。` | `MCPを使わず、リクエストでAIに渡す内容（記憶）を作成してコピーし、ChatGPTやClaudeなど任意のAIに貼り付けられます。設定は不要です。` |

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test && npm run build`
Expected: PASS. Update any Vitest assertion pinning a replaced ConnectView/standing string to the new copy.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/views/ConnectView.tsx
git commit -m "feat(ui): connection one-toggle (自動で渡す/毎回確認) + 詳細 threshold; AIに渡した内容 copy"
```

---

## Task 7: Release gate + everyday-vocabulary sweep

**Files:** none new — verification + cleanup.

- [ ] **Step 1: Everyday-vocabulary leak sweep**

Run: `grep -rnE "Context Pack|候補|ApprovedFact|confidence|Standing Delivery|zero-touch" src/App.tsx src/views/*.tsx src/components/*.tsx`
For each remaining hit, confirm it is EITHER (a) a code identifier / className / handler / comment (allowed), OR (b) hidden inside a `<DetailsDisclosure>` (allowed). Any user-facing everyday-surface occurrence of `Context Pack` / `候補` / `Fact` / `confidence` outside a 詳細 disclosure is a Phase-1 miss — fix it with the same copy rules as Tasks 4–6. List anything intentionally left (and why) in the report.

- [ ] **Step 2: Full release gate**

Run: `npm run product:check`
Expected: ends with `Product release checks passed`. (Do NOT pipe through `tail` — that masks the real exit code; read the final line directly, or grep the full output for `Product release checks passed`.)

- [ ] **Step 3: Visual + dark-mode sanity (manual, browser preview)**

Run `npm run dev` and confirm on the Ingest, Home/Fact, and Connect surfaces: badges read 公開OK/要確認/非公開; candidate cards show 確認待ち/承認済み and a 「この記憶を承認」 button; no `confidence` number, no "Context Pack" noun, no raw 5-tier label is visible until a 「詳細」 is expanded; the connection panel shows one toggle per AI. Check both light and dark themes (badges keep contrast). Capture before/after notes in the report. (Browser preview is UI-review-only per CLAUDE.md — that is exactly the right tool here since this is presentation-only.)

- [ ] **Step 4: Commit any sweep fixes**

```bash
git add -u
git commit -m "chore(ui): everyday-vocabulary sweep — hide remaining machine terms behind 詳細"
```

---

## Self-Review

**1. Spec coverage (Phase 1 transformations 1–6):**
- (1) Unify candidate+Fact as 記憶+status → Task 2 (helper) + Task 4 (candidate card) + Task 5 (fact rows). ✅
- (2) Sensitivity → 3 buckets → Task 1 (helper) + Task 3 (badge) + Task 5 (summaries). Raw tier under 詳細 (badge `title` + Task 5 disclosure). ✅
- (3) Hide confidence → Task 4 (candidate) + Task 5 (fact, moved under 詳細). ✅
- (4) Connection = one toggle ↔ `standingDeliveryEnabled` → Task 6; per-client bar/threshold under 詳細. ✅
- (5) "Context Pack" → 「AIに渡した内容（記憶）」 → Tasks 4, 5, 6 (IngestView, vault.ts, ConnectView, App standing-note). ✅
- (6) 「詳細」 disclosure → Task 3 component, applied in Tasks 5 & 6. ✅
- Phase-1 acceptance (no candidate/Fact/Context Pack/confidence/zero-touch/5-tier on everyday surface) → Task 7 Step 1 sweep enforces it. ✅
- "All existing tests pass; product:check green" → Task 7 Step 2; assertion updates scoped in Tasks 4/5/6. ✅

**2. Placeholder scan:** No "TBD"/"handle appropriately". Every copy change is a concrete from→to. The one deliberately open instruction (Task 5 Step 1 "grep then classify", Task 7 Step 1 sweep) is verification, not implementation — it has explicit accept/reject criteria. ✅

**3. Type consistency:** `SensitivityBucket` / `sensitivityBucketKey` / `sensitivityBucketLabel` (Task 1) used identically in Task 3. `MemoryStatusKey` / `candidateMemoryStatus` / `factMemoryStatus` / `memoryStatusLabel` (Task 2) used identically in Tasks 4–5. `DetailsDisclosure` prop shape (`summary?`, `children`) consistent across Tasks 3/5/6. Engine call `setStandingDelivery(clientId, checked)` unchanged. ✅

**4. Boundary safety:** No task changes the gate, classifier, migration, pack build/retrieval, the data model, or the dual-core security logic. The only `vault.ts` edits are read-only display strings, guarded by a Rust-parity grep. Phase 2 (engine entity merge) is explicitly out of scope. ✅
