# Life Context Vault PoC Implementation Status

Last updated: 2026-06-11

This document is a historical snapshot of the first runnable PoC. The current product-grade implementation has moved beyond several gaps listed here; use `docs/product-grade-implementation-status.md` as the source of truth for current storage, encryption, MCP, Relay, Capture, OCR, and document-ingestion status.

## Implemented In This PoC

- React + Vite local browser app.
- Tauri desktop wrapper.
- SQLite-backed native Vault persistence in the app data directory when running under Tauri.
- Life Context Home with Background Snapshot.
- Guided background setup.
- Memory Inbox with candidate review.
- Source ingestion from manual notes and text-like uploaded files.
- Deterministic local memory candidate extraction.
- ApprovedFact creation through explicit user approval.
- Search over approved facts.
- Context Pack generation with sensitivity labels, warnings, and confirmation state.
- Local deterministic assistant answer from confirmed Context Pack.
- Encrypted JSON backup export and restore through WebCrypto AES-GCM.
- Responsive desktop and mobile UI.

## Verification Run

Commands:

- `npm test`
- `npm run build`
- `npm run tauri:build`
- `npm run tauri:bundle`

Browser smoke checks:

- Desktop viewport `1440x980`: no horizontal overflow.
- Mobile viewport `390x844`: no horizontal overflow.
- Demo data -> Ask -> Context Pack -> local answer: passed.
- Encrypted backup export -> clear Vault -> restore: passed.

Native smoke checks:

- Tauri release binary built at `src-tauri/target/release/life-context-vault`.
- macOS app bundle built at `src-tauri/target/release/bundle/macos/Life Context Vault.app`.
- WindowServer reported a visible `Life Context Vault` window at `1200x820`.
- SQLite file created at `~/Library/Application Support/dev.life-context-vault.poc/vault.sqlite3`.
- SQLite `vault_state` table exists and stores a serialized Vault payload.

## Known Remaining Gaps At The Time

- SQLite currently stores the canonical Vault JSON blob, not the full relational schema from the architecture doc.
- Local database encryption is not implemented yet; encrypted backup export/restore is implemented.
- Document extraction supports text-like files only; PDF/OCR is deferred.
- AI behavior is deterministic local PoC logic, not provider-backed LLM calls.
- MCP adapter is not implemented.

These gaps were intentional for the first fully runnable vertical slice. They are kept here for project history, not as current product status.
