# Life Context Vault — UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the per-use friction and cognitive load of the daily "ask an AI with my context" loop, by replacing per-request in-app confirmation with a pre-set per-connection trust threshold plus post-hoc visibility/revoke, and collapsing the 8-section UI into 3 pillars — without weakening the trust boundary.

**Architecture:** The security boundary stays enforced in one place (the `*_at_path` core in `src-tauri/src/lib.rs`, mirrored by `src/vault.ts`). We do NOT add a new bypass: we stop the `lcv-mcp` sidecar from force-overriding every request to `always_review`, and instead let the existing per-connection policy (`requiresApprovalAbove`) govern what flows zero-touch. Sensitive items still gate; the user just gates them once (a standing threshold) and reviews after the fact in an activity timeline.

**Tech Stack:** Rust (synchronous, `std::thread` + `std::sync::Mutex`, no async runtime) for the Vault Core + 4 sidecars; React 19 + TypeScript + Vite for the UI (`src/App.tsx`, single-file, no router); SQLCipher canonical JSON blob + derived FTS5 projection.

## Global Constraints

- Node 22; Rust stable (min 1.77.2). Commands run from repo root.
- **Trust-boundary invariants — every task must preserve all of these:**
  - Only `ApprovedFact`s are ever deliverable; raw source body and unapproved candidates never reach an AI.
  - `sensitivityCeiling` and `domainAllowlist` are re-validated at retrieval/confirm time, not just at build (`ensure_context_pack_allowed_by_current_policy` / `safe_context_pack_for_client`).
  - `secret_never_send` (tier 4) can never become a Fact and is never deliverable.
  - Every delivery writes an audit event; AI payloads expose only `{reason}` for exclusions, never excluded content.
  - The security decision lives in the core `*_at_path` functions, NOT in a sidecar. Sidecars stay thin transports.
- IPC: Rust structs `#[serde(rename_all = "camelCase")]`; SQL columns snake_case; persisted `vault_state` JSON is TS-shaped (camelCase). IDs via `new_id(prefix)`.
- UI is Japanese-first (`index.html lang="ja"`).
- Sensitivity tier order (rank): `public(0) < personal(1) < private_consequential(2) < sensitive(3) < secret_never_send(4)`.
- Before declaring any boundary-touching task done: extend tests in `src/vault.test.ts` AND the Rust `#[cfg(test)] mod tests`, and run `npm run product:check`.
- **Do NOT run `cargo fmt` to reformat** — repo has no `rustfmt.toml`, code is 2-space indented; rustfmt default (4-space) would rewrite the whole tree. Match the surrounding 2-space style by hand.
- RTK note: this session's `Read`/`Bash` output may be size-compressed. To read raw lines reliably: `awk 'NR>=A && NR<=B {printf "L%d:%s\n", NR, $0}' <file>`.

---

## Design summary (the decisions this plan encodes)

1. **Optimize the daily MCP loop** (primary path: Claude Desktop / ChatGPT). Copy-fallback inherits the same logic later.
2. **Standing trust up to a per-connection threshold.** MCP stops hardcoding `always_review`; the core honors the connection's `requiresApprovalAbove`. Default threshold = `personal` (already the default policy value), so name/tone/preferences/current-focus flow zero-touch; `private_consequential`+ gates.
3. **New connections: conservative TOFU start + incremental promotion** (OS-permission-dialog style: "今回だけ許可" / "今後このtierまで自動"). Existing connections stay strict; standing trust is opt-in per connection. **No silent loosening.**
4. **Above-threshold = non-blocking + async approval.** The AI gets the ≤threshold context immediately plus a "N件承認待ち" marker (content hidden); the user approves later from a notification. No TTL polling on the hot path.
5. **Home = session-grouped activity timeline** ("which AI saw what, and why"), merging Requests + Audit + Background Snapshot, with group- and item-level one-tap revoke. Post-visibility replaces pre-gating.
6. **IA collapses 8 → 3 pillars:** ① 渡った/知っている文脈 (timeline + 記憶/Fact view with inline edit/expire; Search filters this) ② 取り込み (Sources + candidate review merged) ③ 接続と許可 (Connections + thresholds). Search = global bar; Settings tucked.
7. **Candidate→Fact gate kept but fast:** group-by-source bulk approve/reject + inline edit, plus per-source standing trust ("auto-Fact up to tier X"). Passive capture is always manual review.
8. **Passive capture default OFF**, explicit opt-in.
9. **MCP setup = one-button connect per client**, hiding relay/OAuth/agent internals behind a single ready/not-ready/reconnect status.

## Scope check → sub-plans

This spec spans 5 independent subsystems. Per the writing-plans scope-check, each becomes its own shippable plan, executed in this order (each leaves the app working):

- **Plan 1 — Core delivery & trust model** (this document, fully detailed below). Rust core + `lcv-mcp` + `vault.ts`. The boundary-touching heart; ship first, smallest, highest-risk.
- **Plan 2 — Standing-trust UX: TOFU promotion + notifications + non-blocking approve surface.** Needs its own brainstorm (OS notification integration in Tauri is new). Depends on Plan 1.
- **Plan 3 — Activity timeline Home + 3-pillar IA restructure.** Large `App.tsx` refactor. Depends on Plan 1 (consumes delivery/audit events).
- **Plan 4 — Candidate review speed-up + per-source standing trust.** Rust core + `vault.ts` + `App.tsx`.
- **Plan 5 — One-button connection wizard + passive-capture default-off.** `App.tsx` + relay/agent + capture-host.

> Plans 2–5 are scoped at the end of this document with task lists and acceptance criteria. Expand each into its own `docs/superpowers/plans/…` file (with full TDD steps) when you reach it — do not implement them from the outline alone.

---

## Plan 1 — Core delivery & trust model

**What ships:** MCP requests for context at/below a connection's threshold return immediately (zero-touch), while above-threshold requests return non-blocking with a pending marker — but only for connections the user has explicitly opted into standing trust. Existing connections behave exactly as today.

### Why this is small
`src-tauri/src/lib.rs` already computes the right thing: at `create_context_pack_request_at_path`, `approval_mode = approval_mode.unwrap_or("explicit_sensitive")` (lib.rs:1189), `requires_confirmation = approval_mode == "always_review" || max_sensitivity_rank > requires_approval_above_rank` (lib.rs:~1272), and `context_pack = Some(...)` when confirmation status is `not_required` or `confirmed` (lib.rs:~1387). The ONLY reason every MCP request pends is `lcv-mcp.rs:210` passing `Some("always_review")`. We move the decision into the core (single enforcement point) and key it off a new per-connection opt-in flag.

### File structure
- Modify: `src-tauri/src/lib.rs`
  - Add field `standingDeliveryEnabled: bool` to the access-policy shape (schema default + serde) and a resolver `connection_approval_mode(vault, client_id) -> &str`.
  - In `create_context_pack_request_at_path`, when the caller passes `approval_mode = None`, resolve it from the connection (`standingDeliveryEnabled ? "explicit_sensitive" : "always_review"`).
  - Default new access policies to `standingDeliveryEnabled = true`; migration leaves absent/false for existing.
- Modify: `src-tauri/src/bin/lcv-mcp.rs:210` — pass `None` instead of `Some("always_review")`.
- Modify: `src/types.ts` — add `standingDeliveryEnabled?: boolean` to `AccessPolicy`.
- Modify: `src/vault.ts` — mirror the resolver in `createContextPackRequest` default and `normalizeVaultState` (default true on create, preserve on load).
- Modify: `src/nativeStorage.ts` + `src/App.tsx` — surface a per-connection "standing delivery" toggle (minimal; full TOFU UX is Plan 2).
- Test: `src-tauri/src/lib.rs` `#[cfg(test)] mod tests`; `src/vault.test.ts`.

### Interfaces
- Produces (Rust): `fn connection_standing_delivery_enabled(vault: &Value, client_id: &str) -> bool` and `fn connection_approval_mode(vault: &Value, client_id: &str) -> String` returning `"explicit_sensitive"` or `"always_review"`.
- Produces (TS): `AccessPolicy.standingDeliveryEnabled?: boolean`; `connectionApprovalMode(state, clientId): "explicit_sensitive" | "always_review"`.
- Consumes: existing `create_context_pack_request_at_path(path, clientId, clientName, taskText, Some(purpose), Some(ceiling), approvalMode: Option<&str>)` and its TS twin `createContextPackRequest`.

---

### Task 1: Rust — resolve approval mode from per-connection opt-in (core)

**Files:**
- Modify: `src-tauri/src/lib.rs` (access-policy default schema; new resolver; `create_context_pack_request_at_path` approval-mode fallback)
- Test: `src-tauri/src/lib.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `find_vault_item_by_id(vault, "accessPolicies"/connection lookup)`, `str_field`, `bool_field` helpers (add `bool_field` if absent), `create_context_pack_request_at_path`.
- Produces: `fn connection_standing_delivery_enabled(&Value, &str) -> bool`, used inside `create_context_pack_request_at_path` when `approval_mode.is_none()`.

- [ ] **Step 1: Write the failing test** — a connection with standing delivery ENABLED auto-delivers a `personal` fact (no pending), and the same connection with it DISABLED pends. Append to the Rust `mod tests`:

```rust
  #[test]
  fn standing_delivery_flag_governs_mcp_auto_delivery() {
    use_test_vault_key();
    let path = temp_vault_path("standing-delivery-flag");
    let source = add_source_with_candidates_at_path(
      &path, "manual_note", "manual_entry",
      "Passport reminder", "Passport expires on 2028-05-01.",
    ).expect("source");
    approve_candidate_at_path(&path, source.candidate_ids.first().expect("candidate"), None)
      .expect("approve candidate");

    // Connection opted into standing delivery, request approval mode = None (core decides).
    set_connection_standing_delivery_at_path(&path, "conn_chatgpt", true).expect("enable");
    let auto = create_context_pack_request_at_path(
      &path, "conn_chatgpt", "ChatGPT", "When does my passport expire?",
      Some("普段使うAIへの回答文脈"), Some("private_consequential"), None,
    ).expect("auto pack");
    assert_eq!(auto.confirmation_status, "not_required");
    assert!(auto.context_pack.is_some(), "<=threshold must auto-deliver");

    // Same connection with standing delivery OFF must pend.
    set_connection_standing_delivery_at_path(&path, "conn_chatgpt", false).expect("disable");
    let pend = create_context_pack_request_at_path(
      &path, "conn_chatgpt", "ChatGPT", "When does my passport expire?",
      Some("普段使うAIへの回答文脈"), Some("private_consequential"), None,
    ).expect("pending pack");
    assert_eq!(pend.confirmation_status, "pending_user_confirmation");
    assert!(pend.context_pack.is_none(), "strict connection must not auto-deliver");
    remove_temp_vault(&path);
  }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml standing_delivery_flag_governs_mcp_auto_delivery`
Expected: FAIL — `set_connection_standing_delivery_at_path` / resolver not defined (compile error).

- [ ] **Step 3: Write minimal implementation.** Add the resolver, the setter (`set_connection_standing_delivery_at_path` mutates `accessPolicies[clientId].standingDeliveryEnabled` then `save_vault_json_with_projection`), and in `create_context_pack_request_at_path` replace `let approval_mode = approval_mode.unwrap_or("explicit_sensitive");` with:

```rust
  let resolved_mode = match approval_mode {
    Some(mode) => mode.to_string(),
    // Caller (e.g. lcv-mcp) defers to the connection's standing-delivery opt-in.
    // Single enforcement point: the core decides, not the sidecar.
    None => {
      if connection_standing_delivery_enabled(&vault, client_id) {
        "explicit_sensitive".to_string()
      } else {
        "always_review".to_string()
      }
    }
  };
  let approval_mode = resolved_mode.as_str();
```

with helper:

```rust
fn connection_standing_delivery_enabled(vault: &Value, client_id: &str) -> bool {
  find_vault_item_by_id(vault, "accessPolicies", client_id)
    .and_then(|policy| policy.get("standingDeliveryEnabled").and_then(Value::as_bool))
    .unwrap_or(false) // absent = legacy/strict; opt-in is explicit
}
```

(Note: access policies are keyed by `clientId`, not `id` — adjust `find_vault_item_by_id` call or add `find_access_policy(vault, client_id)` if the generic helper keys on `id`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml standing_delivery_flag_governs_mcp_auto_delivery`
Expected: PASS.

- [ ] **Step 5: Run full Rust suite to confirm no regressions**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass (85+ tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(core): resolve MCP approval mode from per-connection standing-delivery opt-in"
```

---

### Task 2: Rust — `lcv-mcp` defers approval decision to the core

**Files:**
- Modify: `src-tauri/src/bin/lcv-mcp.rs:210`

**Interfaces:**
- Consumes: `create_context_pack_request_at_path(..., approval_mode: Option<&str>)` from Task 1.

- [ ] **Step 1: Change the call site.** Replace `Some("always_review")` at lcv-mcp.rs:210 with `None`. Surrounding context (verify with `awk 'NR>=200 && NR<=215 {printf "L%d:%s\n", NR, $0}' src-tauri/src/bin/lcv-mcp.rs`) — the 7th argument to `create_context_pack_request_at_path`:

```rust
    None, // approval mode: defer to the connection's standing-delivery opt-in (enforced in core)
```

- [ ] **Step 2: Build the bins to confirm compile**

Run: `cargo build --manifest-path src-tauri/Cargo.toml --bins`
Expected: `Finished` with no errors.

- [ ] **Step 3: Update the gotcha doc.** In `CLAUDE.md`, replace gotcha #3's "always uses `always_review`… do not 'fix' this" with the new behavior: lcv-mcp defers to the connection's `standingDeliveryEnabled`; strict review remains the default for connections that have not opted in. (Quote the exact new wording in the commit.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/bin/lcv-mcp.rs CLAUDE.md
git commit -m "feat(mcp): defer approval mode to core per-connection policy; honor standing delivery"
```

---

### Task 3: TS — mirror `standingDeliveryEnabled` in types, vault.ts, normalization

**Files:**
- Modify: `src/types.ts` (`AccessPolicy`), `src/vault.ts` (`createContextPackRequest` default approval mode resolver; `normalizeVaultState` default-on-create/preserve-on-load)
- Test: `src/vault.test.ts`

**Interfaces:**
- Produces: `AccessPolicy.standingDeliveryEnabled?: boolean`; `connectionApprovalMode(state, clientId): "explicit_sensitive" | "always_review"`.

- [ ] **Step 1: Write the failing test** in `src/vault.test.ts` (mirror the Rust behavior in the pure-TS path used by the browser/copy fallback):

```ts
  it("standing-delivery opt-in governs whether a personal-tier pack auto-delivers", () => {
    const base = createEmptyVault();
    const now = "2026-06-12T00:00:00.000Z";
    const withFact = normalizeVaultState({
      ...base,
      facts: [{
        id: "fact_name", factText: "Preferred name: Kota", domain: "identity_and_profile",
        factType: "identity", sourceIds: [], sensitivity: "personal", confidence: "inferred_and_confirmed",
        status: "active", createdAt: now, approvedAt: now, updatedAt: now, supersedesFactIds: []
      }]
    });
    const enabled = {
      ...withFact,
      accessPolicies: withFact.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt" ? { ...p, standingDeliveryEnabled: true } : p)
    };
    const r1 = createContextPackRequest(enabled, { clientId: "conn_chatgpt", clientName: "ChatGPT", taskText: "name?", ttlMinutes: 10 });
    const b1 = buildContextPackForRequest(r1.state, r1.request.id);
    expect(b1.pack?.confirmationStatus).toBe("not_required");

    const disabled = {
      ...withFact,
      accessPolicies: withFact.accessPolicies.map((p) =>
        p.clientId === "conn_chatgpt" ? { ...p, standingDeliveryEnabled: false } : p)
    };
    const r2 = createContextPackRequest(disabled, { clientId: "conn_chatgpt", clientName: "ChatGPT", taskText: "name?", ttlMinutes: 10 });
    const b2 = buildContextPackForRequest(r2.state, r2.request.id);
    expect(b2.pack?.confirmationStatus).toBe("pending_user_confirmation");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/vault.test.ts -t "standing-delivery opt-in"`
Expected: FAIL (default approval mode does not yet consult `standingDeliveryEnabled`).

- [ ] **Step 3: Implement.** In `vault.ts`, where `createContextPackRequest` defaults the approval mode, resolve from the connection: `standingDeliveryEnabled === true ? "explicit_sensitive" : "always_review"` (absent → `"always_review"`). Add `standingDeliveryEnabled?: boolean` to `AccessPolicy` in `types.ts`. In `normalizeVaultState`, when creating default policies set `standingDeliveryEnabled: true`; when loading, preserve the stored value (do not coerce absent → true, so existing vaults stay strict).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/vault.test.ts -t "standing-delivery opt-in"`
Expected: PASS.

- [ ] **Step 5: Run full TS suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/vault.ts src/vault.test.ts
git commit -m "feat(vault): mirror standing-delivery opt-in in TS core and normalization"
```

---

### Task 4: Migration safety — new connections default ON, existing stay strict

**Files:**
- Modify: `src-tauri/src/lib.rs` (connection-creation path: set `standingDeliveryEnabled = true` for newly added connections/policies)
- Test: `src-tauri/src/lib.rs` `mod tests`

**Interfaces:**
- Consumes: the connection/policy creation function (find it: `grep -n "accessPolicies\|fn .*connection\|fn .*access_policy" src-tauri/src/lib.rs`).

- [ ] **Step 1: Write the failing test** — a freshly created connection has standing delivery enabled, but a vault loaded with a policy lacking the field is treated as strict:

```rust
  #[test]
  fn new_connections_default_to_standing_delivery_but_legacy_stays_strict() {
    use_test_vault_key();
    let path = temp_vault_path("standing-delivery-migration");
    // Newly created connection (use the real connection-creation entrypoint here):
    let created_client = create_connection_at_path(&path, "New AI", /* args */).expect("connection");
    assert!(connection_standing_delivery_enabled_at_path(&path, &created_client.client_id).expect("read"));
    // Legacy policy without the field reads as strict:
    seed_policy_without_standing_flag_at_path(&path, "conn_legacy").expect("seed");
    assert!(!connection_standing_delivery_enabled_at_path(&path, "conn_legacy").expect("read"));
    remove_temp_vault(&path);
  }
```

(Adjust `create_connection_at_path` to the actual entrypoint and signature; if connections are seeded only via the default vault, test the default-vault policies instead and assert the seeded demo connections are migrated to strict on first load.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml new_connections_default_to_standing_delivery_but_legacy_stays_strict`
Expected: FAIL.

- [ ] **Step 3: Implement.** In the connection-creation path, set `standingDeliveryEnabled: true` on the new policy. Do NOT backfill existing policies. (The resolver's `.unwrap_or(false)` already makes absent = strict.)

- [ ] **Step 4: Run test + full suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(core): new connections default to standing delivery; legacy connections stay strict"
```

---

### Task 5: Minimal per-connection toggle in the UI (bridge to Plan 2)

**Files:**
- Modify: `src/nativeStorage.ts` (IPC: `setNativeConnectionStandingDelivery`), `src-tauri/src/lib.rs` (`#[tauri::command] set_connection_standing_delivery`, register in invoke_handler), `src/App.tsx` (Connections view: a toggle "閾値まで自動配信（standing delivery）" with the current threshold shown)
- Test: covered by Tasks 1/3 at the logic layer; UI is a thin wiring layer.

**Interfaces:**
- Consumes: `set_connection_standing_delivery_at_path` (Task 1), `connection_standing_delivery_enabled`.
- Produces: `setNativeConnectionStandingDelivery({ clientId, enabled }): Promise<NativeVaultSettingsUpdateResult | null>`.

- [ ] **Step 1: Add the Tauri command** in `lib.rs` wrapping `set_connection_standing_delivery_at_path`, return the standard settings-update payload (mirror `update_native_access_policy`). Register it in the `invoke_handler!` list.

- [ ] **Step 2: Add the IPC shim** in `nativeStorage.ts` mirroring `updateNativeAccessPolicy`.

- [ ] **Step 3: Add the toggle** in the Connections view of `App.tsx`: a checkbox bound to the policy's `standingDeliveryEnabled`, labelled in Japanese, with helper text "このtier（{requiresApprovalAbove}）まではタップなしでAIに渡ります。超える項目は通知で承認。" Wire `onChange` to `setNativeConnectionStandingDelivery`, fall back to the pure-TS path when not in Tauri.

- [ ] **Step 4: Verify end-to-end** with `npm run tauri:dev`: toggle on for ChatGPT, issue an MCP request for name-tier context, confirm it returns without an in-app confirmation; toggle off, confirm it pends. Record the observation.

- [ ] **Step 5: Run the release gate**

Run: `npm run product:check`
Expected: pass (fmt step is pre-existing-skipped in CI / your edits are 2-space).

- [ ] **Step 6: Commit**

```bash
git add src/nativeStorage.ts src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(ui): per-connection standing-delivery toggle (bridge to TOFU UX)"
```

### Plan 1 acceptance criteria
- An opted-in connection auto-delivers ≤`requiresApprovalAbove` context with zero in-app interaction; >threshold pends without blocking the AI.
- A connection that has not opted in behaves exactly as today (always pends).
- Existing vaults load with all connections strict; only newly created connections default to standing delivery.
- `npm run product:check` passes; all boundary invariants intact (covered by Tasks 1–4 tests).

---

## Plan 2 — Standing-trust UX: TOFU promotion + notifications + non-blocking approve (OUTLINE)

> Expand into its own plan; OS-notification integration in Tauri is new and needs a short brainstorm.

**Tasks (acceptance-criteria level):**
- **2.1 Pending-with-marker payload:** when a request pends above threshold, the MCP/relay response carries a non-content marker (`pendingCount`, `pendingReason`) so the AI can tell the user "N items await your approval" — content stays hidden (extends `AiContextPackPayload`, preserving the `{reason}`-only rule). Test: payload exposes count + reason, never item text.
- **2.2 One-tap approval grants:** a pending item can be resolved two ways — "今回だけ許可" (one-shot: deliver these items on next fetch, threshold unchanged) and "今後このtierまで自動" (promote `requiresApprovalAbove` for this connection). Core functions: `approve_pending_request_once_at_path`, `promote_connection_threshold_at_path`. Tests for both, plus that promotion is connection-scoped and audited.
- **2.3 OS notification surface:** Tauri notification with inline approve actions deep-linking to the grant; fallback to the timeline if missed. Brainstorm Tauri notification capabilities first.
- **2.4 Non-blocking next-turn delivery:** approved-once items become available on the AI's next fetch without re-prompting; verify no TTL polling on the hot path.

---

## Plan 3 — Activity timeline Home + 3-pillar IA (OUTLINE)

> Large `App.tsx` restructure (single ~8k-line file, no router — navigate by grep). Behavior-neutral to the boundary; verify via UI E2E (Playwright on the browser preview).

**Tasks:**
- **3.1 Session-grouped timeline data:** derive timeline groups from audit/delivery events keyed by `(clientId, session/time-window)`; each group lists deliveries, expandable to items. Pure function in `vault.ts` + tests.
- **3.2 Group- and item-level revoke:** "今後これは渡さない" (hide fact for client / lower threshold) wired to existing fact-hide + policy paths; audited.
- **3.3 Home = timeline** replacing the Requests/Audit/Background-Snapshot panels.
- **3.4 三柱ナビ:** collapse nav to ① 文脈 ② 取り込み ③ 接続; Search → global bar that filters the 記憶 (Fact) list; Settings tucked.
- **3.5 記憶 view:** Fact list with inline edit/expire under pillar ①.
- **Acceptance:** all prior flows reachable in ≤3 destinations; Playwright E2E covers add→approve→deliver→see-in-timeline→revoke.

---

## Plan 4 — Candidate review speed-up + per-source standing trust (OUTLINE)

**Tasks:**
- **4.1 Bulk operations:** group candidates by source; bulk approve/reject; inline edit. Core: `approve_candidates_bulk_at_path(ids[])`. Tests including mixed-sensitivity batches.
- **4.2 Per-source standing trust:** `RawSource.autoApproveUpToTier?: SensitivityTier`; on ingest, candidates ≤ tier from a trusted source auto-become Facts (still subject to delivery gates). `secret_never_send` never auto. Passive-capture sources may never be marked trusted. Tests.
- **Acceptance:** trusted-source ingest produces Facts without manual review; passive capture always lands in the review queue.

---

## Plan 5 — One-button connection wizard + passive-capture default-off (OUTLINE)

**Tasks:**
- **5.1 Connect wizards:** "Claude Desktopを接続" / "ChatGPTを接続" orchestrate relay/OAuth/agent; expose a single status enum (`connected | not_connected | needs_reconnect`); hide `statusToken`/`processId`/`agent_ready`.
- **5.2 Passive capture default OFF:** capture host inert until explicit opt-in; settings toggle; first-run copy explains scope.
- **Acceptance:** a fresh user reaches "connected" in one button per client; passive capture never runs without explicit enable.

---

## Self-review notes
- **Spec coverage:** Decisions 1–9 map to Plans 1–5 (1–4 → Plan 1; 5–6 → Plan 3; 7 → Plan 4; 8 → Plan 5; 9 → Plan 5; non-blocking/TOFU → Plan 2). No decision is unassigned.
- **Type consistency:** `standingDeliveryEnabled` (TS `AccessPolicy` / Rust `accessPolicies[].standingDeliveryEnabled`) used identically across Tasks 1, 3, 4, 5; resolver name `connection_standing_delivery_enabled` consistent.
- **Boundary:** Plan 1 changes WHO decides the approval mode and adds an explicit opt-in; it does NOT remove any retrieval-time check. The earlier `source.defaultSensitivity <= ceiling` delivery bug fix (separate, already merged on this branch) is unaffected.
- **Open verification before coding Task 1/4:** confirm the access-policy key field (`clientId`) and the real connection-creation entrypoint name; adjust `find_*` calls accordingly.
