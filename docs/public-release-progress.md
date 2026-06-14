# Public-Release Progress — Life Context Vault

Status of the public-release plan. Branch: `feat/p0-public-release`
(16 commits ahead of `master`). All Rust changes are TDD; full suite green
(`cargo test` 96 pass), frontend `tsc --noEmit` clean, `vitest` 68 pass.

## P0 status

### Done (verified)
- **P0-C backup** — Rust encrypted backup envelope (PBKDF2-SHA256 600k +
  AES-GCM-256, byte-compatible with the TS path) + `*_at_path` + Tauri commands
  + frontend IPC + UI routed through the native path. TDD.
- **P0-C recovery key** — crypto core (generate/wrap/unwrap; GCM-tag verifier)
  + sidecar IO (write/recover-key, file next to the DB). TDD.
- **P0-C onboarding** — Home empty state replaced with a 3-step Getting Started
  card (background → Inbox → backup).
- **P0-D graceful OCR/Office fallback** — `add_native_source_pending_runtime`:
  images/legacy-Office without a runtime register as `needs_runtime` instead of
  hard rejection. Backend command (TDD) + types + frontend wiring.
- **P0-D error surfacing** — native vault save failures now surface via
  `setNotice` (were silent `console.warn`).
- **P0-E CSP** — real CSP in `tauri.conf.json` (was `null`); blocks remote
  scripts/connections. (Tauri 2 custom commands aren't capability-gated, so
  `core:default` is correct — the plan's capability-coverage assertion was a
  model misunderstanding, dropped.)
- **P0-F rate limiting + hardening** — per-IP `RateLimiter` on the public relay
  (TDD; memory-bounded, fail-closed; boundary-spike tradeoff documented).
- **P0-F ops runbook** — `docs/relay-operations.md`.
- **P0-G legal/privacy (draft)** — `SECURITY.md`, `docs/privacy-policy.md`,
  `docs/data-deletion.md`.
- **P0-A scaffold** — updater config, macOS entitlements, `release.yml`
  (sign+notarize+staple on tag), `docs/release-and-signing.md`.
- **P0-B foundation** — `src/managedRelay.ts` (endpoint + pairing URL builder).

### Corrections to the plan (important)
1. **P0-D "543 panics block release" was overstated.** `.expect()` on the
   vault-open/schema/key/crypto paths are all inside `#[cfg(test)]` — test-only.
   Production paths already return `Result<_, String>`; a corrupt vault or
   Keychain quirk surfaces as an error, not a crash. Remaining P0-D was UX
   (OCR fallback + error surfacing) — now done.
2. **P0-F "relay has security holes" was largely a false positive.** The relay
   already enforced (non-loopback) https + admin token + handoff secret + allowed
   origins + tenant isolation + no static bearer, and CIMD fetch already had
   full SSRF protection (host allowlist, public-IP DNS verify, private-IP
   reject, `redirects(0)`, 10s timeout, 128KB cap, JSON check). Added the
   missing ops layer (rate limiting + runbook).

### Remaining P0
- **P0-B full one-click** — needs a relay-side pairing-issuance endpoint the app
  can call (currently pairing is admin-initiated). `managedRelay.ts` foundation
  is in place; the relay API + Connections UI wiring is the follow-up.
- **P0-C scheduled backup** + **recovery full-flow** (open DB with the recovered
  key via a new `open-with-key` path + re-establish Keychain). Backup-restore
  already covers cross-machine recovery via the passphrase.
- **P0-A cert + updater plugin runtime** — Apple Developer ID certificate +
  notarization secrets (user); `tauri-plugin-updater`/`-process` registration +
  Settings UI (independent of signing).
- **P0-G decisions** — license (OSS vs proprietary), telemetry stance,
  maintainer contact (user).
- **P0-F module split** of `lcv-relay.rs` (6k lines) — maintainability, not
  security.

## P1 / P2 (not started)
- P1-A i18n (EN/JA) + App.tsx split; P1-B sqlite-vec semantic retrieval
  (feasibility spike gates — coexistence with vendored SQLCipher is unverified);
  P1-C gated LLM-assisted extraction; P1-D vault-backed Settings UI; P1-E
  automated backup hardening.
- P2: more connectors, prospective memory, cross-platform packaging, sharing.

## How to resume
The branch compiles and all tests pass. Highest-value next increments:
1. P0-B relay pairing API + Connections one-click UI.
2. P1-A i18n + App.tsx module split.
3. P0-C scheduled backup + recovery full-flow.
4. P1-B sqlite-vec spike (de-risk before committing).
