# Public-Release Progress — Life Context Vault

Living status of the public-release plan (`~/.claude/plans/splendid-prancing-falcon.md`).
Branch: `feat/p0-public-release`.

## Completed (verified)

### P0-C (partial) — Encrypted backup, Rust path
- New `src-tauri/src/vault_backup.rs`: PBKDF2-SHA256 (600k) + AES-GCM-256
  envelope, **byte-compatible with the legacy TS impl** (`src/vault.ts:2117`).
  TDD: 7 unit tests + 1 DB round-trip integration test (RED → GREEN).
- `export_encrypted_backup_at_path` / `import_encrypted_backup_at_path`
  (`*_at_path` convention) + `#[tauri::command]` wrappers
  (`export_native_encrypted_backup`, `import_native_encrypted_backup`),
  registered in `run()`.
- Frontend IPC: `exportNativeEncryptedBackup` / `importNativeEncryptedBackup`
  in `src/nativeStorage.ts`.
- New deps: `pbkdf2 = "0.12"`, `aes-gcm = "0.10"`.
- Backup-restore **already enables cross-machine recovery**: restoring a
  `.lcvbak` on a new Mac re-encrypts the payload with the new machine's
  Keychain key, gated by the backup passphrase — no original Keychain needed.
  This reduces the urgency of a separate recovery key (see below).

### P0-E — CSP hardening
- Real CSP in `src-tauri/tauri.conf.json` (was `null`): blocks remote
  scripts/connections; allows self/tauri/asset, ipc, dev server, loopback relay,
  data/blob images, inline styles. **Needs runtime validation** in the Tauri
  webview before sign-off.
- Note: in Tauri 2, custom `#[tauri::command]`s are NOT gated by the capability
  permission system; `capabilities/default.json` (`core:default`) is correct.
  The plan's "capability covers every IPC" assertion was based on a
  misunderstanding of the Tauri 2 model — dropped.

### P0-G (draft) — Legal & privacy
- `SECURITY.md` (trust model + vuln reporting; `SECURITY_CONTACT` placeholder).
- `docs/privacy-policy.md` (local-first data handling; telemetry = none default).
- `docs/data-deletion.md` (GDPR/APPI right-to-erasure checklist).
- **User decisions still needed**: license (OSS vs proprietary), telemetry
  stance confirmation, maintainer contact address.

### P0-A (scaffold) — Distribution
- `tauri.conf.json`: `plugins.updater` (pubkey placeholder), `bundle.macOS`
  (signingIdentity `-`, entitlements), `createUpdaterArtifacts`.
- `src-tauri/entitlements.mac.plist` (hardened-runtime compatible).
- `.github/workflows/release.yml` (tag `v*` → product:check gate → macOS
  sign+notarize+staple → artifacts + GitHub Release). Safe from workflow
  injection (no untrusted input in `run:`).
- `docs/release-and-signing.md` (Apple Developer enrollment, updater keygen,
  secrets, per-release steps).
- **External blocker**: Apple Developer ID certificate + notarization secrets
  (user). **Follow-up**: register `tauri-plugin-updater`/`-process` runtime +
  Settings UI (independent of signing).

## Corrections to the plan (important)

1. **P0-D "543 panics block release" was overstated.** All `.expect()` on the
   vault-open / schema / key / crypto paths are inside `#[cfg(test)] mod tests`
   — test-only. Production paths already return `Result<_, String>`. A corrupt
   vault or Keychain quirk surfaces as an error to the frontend, not a crash.
   Remaining P0-D work is UX only (OCR/Office graceful `needs_runtime` fallback,
   frontend error toasts) — not a release blocker.
2. **P0-F "relay has security holes" was largely a false positive.** The relay
   already enforces, for non-loopback binds: https, admin token, handoff secret,
   allowed origins, tenant isolation, no static bearer
   (`validate_relay_surface`). CIMD metadata fetch already has full SSRF
   protection (host allowlist, public-IP DNS verification, private/loopback IP
   rejection, `redirects(0)`, 10s timeout, 128KB cap, JSON content-type check).
   Remaining P0-F work is operational (rate-limiting/abuse defense, monitoring
   runbook, splitting the 6k-line file) — production hardening, not holes.

## Remaining

- **P0-B** one-click managed-relay connect (frontend: `src/managedRelay.ts` +
  `ConnectionsView` rework; backend pieces largely exist).
- **P0-C** onboarding wizard (force first backup), scheduled local backup,
  recovery key (lower priority now that backup-restore covers recovery).
- **P0-D** OCR/Office `needs_runtime` graceful fallback; frontend error surface.
- **P0-F** rate-limiting/abuse defense; ops runbook; `lcv-relay.rs` module split.
- **P0-A** updater plugin runtime wiring + cert/secret injection (external).
- **P1** i18n (EN/JA) + App.tsx split; sqlite-vec semantic retrieval (feasibility
  spike gates); gated LLM-assisted extraction; vault-backed Settings UI.
- **P2** more connectors; prospective memory; cross-platform packaging; sharing.
