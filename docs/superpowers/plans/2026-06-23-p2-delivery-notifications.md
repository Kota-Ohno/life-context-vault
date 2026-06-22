# P2 — Non-blocking OS delivery notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** When a Context Pack is **zero-touch** delivered to an AI client (no user confirmation), the
main app raises a **non-blocking, coalesced OS notification** ("ChatGPT に 3 件の文脈を渡しました")
that deep-links to the disclosure ledger — so the user keeps real-time awareness without friction. This
is the post-hoc trust UX that compensates for removing the pre-delivery gate on low-sensitivity content
(grilling Q7/Q11; spec decision 7 + §6 P2).

**Architecture:** Deliveries happen in sidecars (`lcv-mcp`, relay/agent) which write to the shared
`audit_events` table, but OS notifications must fire from the **main Tauri app** (it owns the tray +
notification permission). There is no app-side vault watcher today. So: the app runs a **background
poller** that periodically reads NEW zero-touch-delivery audit events since a persisted marker, coalesces
them, and fires one OS notification via `tauri-plugin-notification`. Pure decision logic is unit-tested;
the plugin/permission/poller/deep-link is a thin integration layer (manually verified).

**Tech Stack:** Rust + Tauri v2 (`src-tauri/src/lib.rs`, `run()` @9209 / `.setup()` @9270 /
`configure_background_tray` @8229), `tauri-plugin-notification`. App-only (NOT dual-core).

**Source of truth:** `docs/superpowers/specs/2026-06-22-north-star-and-improvement-plan.md` (decision 7, §6 P2).

## Global Constraints
- **NEVER put fact/source/candidate CONTENT in the notification.** OS notifications surface to the
  notification center / lock screen. The body is ONLY the human client name + a count (and optionally the
  sensitivity tier label) — never the delivered text. This is a trust-boundary requirement.
- **Only ZERO-TOUCH deliveries notify.** A delivery the user explicitly confirmed (`pending_user_confirmation`
  → confirmed) is already known to them; do NOT notify for those. Notify only for auto-delivered
  (`confirmation_status == "not_required"`) packs that were actually returned to a client.
- **Opt-in gated.** Notifications fire only when the user has enabled them AND granted the OS permission.
  Default OFF until enabled. Enabling triggers the OS permission request.
- **Coalesce.** Multiple deliveries within one poll window become ONE notification summarizing per-client
  counts. Never spam one-per-delivery.
- **App-only, idempotent.** The poller persists a last-seen marker so each delivery notifies at most once,
  and a restart does not re-notify old deliveries.
- **No new dependency on the relay/agent.** The app observes the shared vault DB only.
- Keep Rust 2-space + rustfmt-clean (R3; `product:check` enforces `cargo fmt --check`).

## File Structure
- `src-tauri/src/lib.rs` — the pure selector + the poller thread in `.setup()` + the opt-in setting/IPC +
  the notification-emit + deep-link handler. (Keep the pure selector in its own `fn` for testing.)
- `src-tauri/Cargo.toml`, `src-tauri/capabilities/*.json`, `src-tauri/tauri.conf.json` — add
  `tauri-plugin-notification` + its capability/permission.
- `src/` (TS) — a Settings toggle for "delivery notifications" + the IPC call (small).

---

## Task 1: Pure delivery-notification selector (Rust, TDD) + discovery

**Files:** `src-tauri/src/lib.rs` (+ `mod tests`).

**Discovery (do FIRST, record in report):** read the `audit_event(...)` call sites (e.g. lib.rs ~1393/1408
and the retrieval/return path) to identify (a) the exact `eventType` string logged when a pack is
DELIVERED/returned to a client, and (b) how to distinguish a ZERO-TOUCH delivery (`not_required`) from a
user-confirmed one (check the event metadata / a confirmation field). If delivery is not currently
audited distinctly from generation, note it — Task 3 may need to add a delivery audit event at the
return site (`safe_context_pack_for_client` / get_request_status path).

**Interfaces — Produces:** `fn select_delivery_notification(events: &[Value], last_seen_id: Option<&str>, opted_in: bool) -> Option<DeliveryNotice>` where `DeliveryNotice { per_client: Vec<(String /*human client name*/, usize /*count*/)>, total: usize, newest_event_id: String }`. Returns `None` if `!opted_in`, or no new zero-touch deliveries since `last_seen_id`.

- [ ] **Step 1 — failing tests:**
  - opted-out ⇒ `None` even with new deliveries.
  - 2 zero-touch deliveries to ChatGPT + 1 to Claude since marker ⇒ `Some` with per-client `[("ChatGPT",2),("Claude",1)]`, total 3, `newest_event_id` = the latest.
  - a user-confirmed delivery ⇒ NOT counted.
  - events at/before `last_seen_id` ⇒ NOT counted (idempotent).
  - no content fields leak into `DeliveryNotice` (only names + counts).
- [ ] **Step 2 — run, expect FAIL** — `cargo test --manifest-path src-tauri/Cargo.toml select_delivery`.
- [ ] **Step 3 — implement** the pure selector (filter by the discovered delivery eventType + zero-touch
  marker, drop ≤ last_seen, group by client display name via the existing connection-name map, summarize).
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit** — `feat: pure zero-touch delivery-notification selector (coalesced, content-free)`.

---

## Task 2: Notification plugin + capability + opt-in setting

**Files:** `src-tauri/Cargo.toml`, `src-tauri/capabilities/*.json`, `src-tauri/tauri.conf.json`,
`src-tauri/src/lib.rs`, `src/` (Settings toggle).

- [ ] **Step 1:** add `tauri-plugin-notification` to `Cargo.toml`; register `.plugin(tauri_plugin_notification::init())` in `run()`; add the notification permission to the app capability JSON.
- [ ] **Step 2:** add a persisted opt-in setting `deliveryNotificationsEnabled` (in the vault settings blob / app config) defaulting **false**; add an IPC command `set_delivery_notifications_enabled(enabled)` that, when enabling, requests the OS notification permission (`tauri_plugin_notification` permission API) and stores the result.
- [ ] **Step 3:** add a Settings toggle in the TS UI calling that IPC (small; mirror an existing settings toggle). Wire the human-readable copy (Japanese-first).
- [ ] **Step 4 — verify:** `npm run build` clean, `cargo build` clean, `cargo fmt --check` clean. (Permission flow is manually verified in Task 4.)
- [ ] **Step 5 — commit** — `feat: tauri-plugin-notification + opt-in setting for delivery notifications`.

---

## Task 3: Background poller + emit + deep-link

**Files:** `src-tauri/src/lib.rs` (`.setup()` near `configure_background_tray`).

- [ ] **Step 1:** in `.setup()`, spawn a background `std::thread` (matches the app's synchronous threading
  model) that loops every ~15s: open the vault, read recent `audit_events`, read the persisted last-seen
  marker + the opt-in setting, call `select_delivery_notification`, and if `Some`, emit ONE OS
  notification (title app name, body "<client> に <total> 件の文脈を渡しました" — per-client summary;
  NO content), then persist `newest_event_id` as the new marker. Guard the thread so it stops cleanly on
  app exit and never double-runs.
- [ ] **Step 2:** make the notification click **deep-link to the ledger** — on activation, focus/show the
  main window and navigate the UI to the disclosure ledger (emit a Tauri event the front-end listens for,
  or a deep-link route). Mirror how `show_control_center` / tray menu focuses the window.
- [ ] **Step 3:** if Task 1 discovery found that zero-touch DELIVERY is not audited distinctly, add a
  delivery audit event at the return site (`safe_context_pack_for_client` / the get_request_status path)
  carrying the client id + `not_required` marker — minimal, content-free, behind the existing audit
  machinery. (Re-verify the boundary: audit receipts stay metadata-only.)
- [ ] **Step 4 — verify:** `cargo build`/`cargo test` green; `cargo fmt --check` clean.
- [ ] **Step 5 — commit** — `feat: background delivery-notification poller + deep-link to ledger`.

---

## Task 4: Release gate + manual verification

- [ ] **Step 1 — `npm run product:check`** passes end-to-end.
- [ ] **Step 2 — manual verification checklist** (OS notification firing can't be unit-tested) in `tauri:dev`:
  enable the setting (OS permission prompt appears) → trigger a zero-touch delivery (via MCP/an auto pack)
  → ONE coalesced notification appears with client+count and NO content → click it → app focuses on the
  ledger. Then: opted-out ⇒ no notification; a user-confirmed delivery ⇒ no notification; restart ⇒ old
  deliveries do not re-notify. Record results.
- [ ] **Step 3 — commit** any fixes.

## Self-Review
- Spec decision 7 / §6 P2 (non-blocking OS notification, coalesced, deep-link, opt-in, post-hoc) → T1-T3.
- Trust boundary: notification is content-free (constraint + T1 test); audit stays metadata-only (T3).
- Testable core (selector) is TDD'd; OS/permission/poller integration is manually verified (T4) — stated, not hidden.
- App-only (not dual-core) — sidecars are unaffected; the app observes the shared audit log.
